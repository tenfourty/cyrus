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

import { describe, expect, it, vi } from "vitest";
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
