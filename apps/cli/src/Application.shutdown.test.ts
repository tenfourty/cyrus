/**
 * Tests for Application.shutdown idempotency.
 *
 * Background: a single `systemctl restart` on busy hosts can deliver SIGTERM
 * twice (cgroup kill + pnpm signal forwarding). The handler used to spawn
 * an unguarded `void this.shutdown()` per signal — two parallel shutdown
 * chains, both racing to call `worker.stop()` (which writes the persistence
 * file) and then `process.exit(0)`. The first chain to reach `process.exit`
 * killed the other mid-write, leaving the persistence file empty.
 *
 * Fix: `shutdown()` is now idempotent. Subsequent calls return the same
 * Promise as the first, so signal handlers and the uncaughtException path
 * cannot race their save+exit chains.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { DrainOutcome } from "cyrus-edge-worker";
import { Application } from "./Application.js";

function makeAppWithMockedShutdownDeps(): {
	app: Application;
	stopCalls: { count: number };
} {
	// Bypass the real constructor — we only need an instance whose shutdown()
	// path we can drive. `worker.stop()` is the load-bearing call we count.
	const app = Object.create(Application.prototype) as Application;
	const stopCalls = { count: 0 };

	(app as any).logger = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		withContext: () => (app as any).logger,
	};
	(app as any).envWatcher = undefined;
	(app as any).configWatcher = undefined;
	(app as any).worker = {
		stop: vi.fn(async () => {
			stopCalls.count += 1;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}),
		getDrainController: vi.fn(() => ({
			beginDrain: vi.fn().mockResolvedValue({
				kind: "drained",
				durationMs: 0,
				sessionCount: 0,
			} satisfies DrainOutcome),
			abortDrain: vi.fn(),
			isDraining: vi.fn().mockReturnValue(false),
		})),
	};
	(app as any).errorReporter = {
		flush: vi.fn().mockResolvedValue(true),
	};

	// Stub process.exit so the test process doesn't actually die.
	vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
		// no-op
	}) as never);

	return { app, stopCalls };
}

/**
 * Helper that builds an app with full drain/signal-handler mocks so we can
 * emit synthetic SIGTERM / SIGINT / uncaughtException events via
 * process.emit().
 */
function makeAppWithSignalHandlers(): {
	app: Application;
	stopFn: ReturnType<typeof vi.fn>;
	beginDrainFn: ReturnType<typeof vi.fn>;
	abortDrainFn: ReturnType<typeof vi.fn>;
	isDrainingFn: ReturnType<typeof vi.fn>;
} {
	const app = Object.create(Application.prototype) as Application;

	const logger = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		withContext: () => logger,
	};
	(app as any).logger = logger;
	(app as any).envWatcher = undefined;
	(app as any).configWatcher = undefined;
	(app as any).shutdownPromise = undefined;
	(app as any).sigtermCount = 0;

	const stopFn = vi.fn().mockResolvedValue(undefined);
	const beginDrainFn = vi.fn().mockResolvedValue({
		kind: "drained",
		durationMs: 100,
		sessionCount: 0,
	} satisfies DrainOutcome);
	const abortDrainFn = vi.fn();
	const isDrainingFn = vi.fn().mockReturnValue(false);

	(app as any).worker = {
		stop: stopFn,
		getDrainController: vi.fn(() => ({
			beginDrain: beginDrainFn,
			abortDrain: abortDrainFn,
			isDraining: isDrainingFn,
		})),
	};
	(app as any).errorReporter = {
		flush: vi.fn().mockResolvedValue(true),
	};

	vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
		// no-op
	}) as never);

	// Register signal handlers on this app instance.
	app.setupSignalHandlers();

	return { app, stopFn, beginDrainFn, abortDrainFn, isDrainingFn };
}

describe("Application.shutdown idempotency", () => {
	it("runs the shutdown body exactly once when called multiple times in quick succession", async () => {
		const { app, stopCalls } = makeAppWithMockedShutdownDeps();

		await Promise.all([app.shutdown(), app.shutdown(), app.shutdown()]);

		expect(stopCalls.count).toBe(1);
	});

	it("returns the same Promise for concurrent callers (no parallel save+exit chains)", async () => {
		const { app } = makeAppWithMockedShutdownDeps();

		const p1 = app.shutdown();
		const p2 = app.shutdown();
		const p3 = app.shutdown();

		expect(p1).toBe(p2);
		expect(p2).toBe(p3);

		await Promise.all([p1, p2, p3]);
	});

	it("still runs the shutdown body once even if the first call is awaited before the second arrives", async () => {
		const { app, stopCalls } = makeAppWithMockedShutdownDeps();

		await app.shutdown();
		await app.shutdown();

		expect(stopCalls.count).toBe(1);
	});
});

describe("Application signal-handler drain behaviour", () => {
	// Remove signal listeners installed by makeAppWithSignalHandlers after each
	// test so tests don't bleed into each other.
	afterEach(() => {
		process.removeAllListeners("SIGTERM");
		process.removeAllListeners("SIGINT");
		process.removeAllListeners("uncaughtException");
		process.removeAllListeners("unhandledRejection");
		vi.restoreAllMocks();
	});

	it("first SIGTERM enters drain mode and awaits outcome before stopping worker", async () => {
		const { stopFn, beginDrainFn } = makeAppWithSignalHandlers();

		// Emit a synthetic SIGTERM — process.emit is synchronous so the handler
		// fires inline; we then await all microtasks / timers with a small flush.
		process.emit("SIGTERM");

		// Flush microtasks so the async drain chain runs to completion.
		await new Promise<void>((resolve) => setImmediate(resolve));
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(beginDrainFn).toHaveBeenCalledOnce();
		expect(beginDrainFn).toHaveBeenCalledWith("sigterm");
		// stop must be called AFTER beginDrain resolves, and with the outcome.
		expect(stopFn).toHaveBeenCalledOnce();
		const drainOutcome: DrainOutcome = {
			kind: "drained",
			durationMs: 100,
			sessionCount: 0,
		};
		expect(stopFn).toHaveBeenCalledWith(drainOutcome);
		expect(process.exit).toHaveBeenCalledWith(0);
	});

	it("second SIGTERM during drain calls abortDrain", async () => {
		// Arrange: beginDrain never resolves (simulate in-flight drain)
		const app = Object.create(Application.prototype) as Application;
		const logger = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
			withContext: () => logger,
		};
		(app as any).logger = logger;
		(app as any).envWatcher = undefined;
		(app as any).configWatcher = undefined;
		(app as any).shutdownPromise = undefined;
		(app as any).sigtermCount = 0;

		const abortDrainFn = vi.fn();
		const neverResolvingBeginDrain = vi.fn(
			() => new Promise<DrainOutcome>(() => {
				// intentionally never resolves
			}),
		);

		(app as any).worker = {
			stop: vi.fn().mockResolvedValue(undefined),
			getDrainController: vi.fn(() => ({
				beginDrain: neverResolvingBeginDrain,
				abortDrain: abortDrainFn,
				isDraining: vi.fn().mockReturnValue(true),
			})),
		};
		(app as any).errorReporter = { flush: vi.fn().mockResolvedValue(true) };

		vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {}) as never);

		app.setupSignalHandlers();

		// First SIGTERM — enters drain; beginDrain will never resolve
		process.emit("SIGTERM");
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(neverResolvingBeginDrain).toHaveBeenCalledOnce();
		expect(abortDrainFn).not.toHaveBeenCalled();

		// Second SIGTERM — should abort drain
		process.emit("SIGTERM");
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(abortDrainFn).toHaveBeenCalledOnce();
	});

	it("SIGINT bypasses drain entirely and shuts down immediately", async () => {
		const { stopFn, beginDrainFn } = makeAppWithSignalHandlers();

		process.emit("SIGINT");

		await new Promise<void>((resolve) => setImmediate(resolve));
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(beginDrainFn).not.toHaveBeenCalled();
		expect(stopFn).toHaveBeenCalledOnce();
		// SIGINT calls shutdown() → performShutdown(undefined) → worker.stop(undefined)
		expect(stopFn).toHaveBeenCalledWith(undefined);
		expect(process.exit).toHaveBeenCalledWith(0);
	});

	it("uncaughtException bypasses drain entirely", async () => {
		const { stopFn, beginDrainFn } = makeAppWithSignalHandlers();

		process.emit("uncaughtException", new Error("test error"));

		await new Promise<void>((resolve) => setImmediate(resolve));
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(beginDrainFn).not.toHaveBeenCalled();
		expect(stopFn).toHaveBeenCalledOnce();
		expect(process.exit).toHaveBeenCalledWith(1);
	});

	it("drain failure (beginDrain rejects) still proceeds to worker.stop and exit", async () => {
		const app = Object.create(Application.prototype) as Application;
		const logger = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
			withContext: () => logger,
		};
		(app as any).logger = logger;
		(app as any).envWatcher = undefined;
		(app as any).configWatcher = undefined;
		(app as any).shutdownPromise = undefined;
		(app as any).sigtermCount = 0;

		const stopFn = vi.fn().mockResolvedValue(undefined);
		const beginDrainFn = vi.fn().mockRejectedValue(new Error("controller bug"));

		(app as any).worker = {
			stop: stopFn,
			getDrainController: vi.fn(() => ({
				beginDrain: beginDrainFn,
				abortDrain: vi.fn(),
				isDraining: vi.fn().mockReturnValue(false),
			})),
		};
		(app as any).errorReporter = { flush: vi.fn().mockResolvedValue(true) };

		vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {}) as never);

		app.setupSignalHandlers();

		process.emit("SIGTERM");

		await new Promise<void>((resolve) => setImmediate(resolve));
		await new Promise<void>((resolve) => setImmediate(resolve));

		// Error should be logged
		expect(logger.error).toHaveBeenCalled();
		// worker.stop must still be called (no outcome since drain failed)
		expect(stopFn).toHaveBeenCalledOnce();
		// process exits with 0 even after drain failure
		expect(process.exit).toHaveBeenCalledWith(0);
	});
});
