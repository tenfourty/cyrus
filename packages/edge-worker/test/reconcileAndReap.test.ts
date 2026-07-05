import { AgentSessionStatus } from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import { reconcileAndReap } from "../src/reconcileAndReap.js";

function makeSession(status: AgentSessionStatus, running: boolean) {
	const runner = { isRunning: () => running, stop: vi.fn() };
	const session = {
		status,
		agentRunner: runner as { isRunning(): boolean; stop(): void } | undefined,
	};
	return { session, runner };
}

describe("reconcileAndReap", () => {
	it("stops a live runner and clears it on Error", () => {
		const { session, runner } = makeSession(AgentSessionStatus.Error, true);
		const reapWarmInstance = vi.fn();
		reconcileAndReap("s1", { getSession: () => session, reapWarmInstance });
		expect(runner.stop).toHaveBeenCalledOnce();
		expect(session.agentRunner).toBeUndefined();
		expect(reapWarmInstance).toHaveBeenCalledWith("s1");
	});

	it("clears (does not stop) an already-dead runner on Error", () => {
		const { session, runner } = makeSession(AgentSessionStatus.Error, false);
		reconcileAndReap("s1", {
			getSession: () => session,
			reapWarmInstance: vi.fn(),
		});
		expect(runner.stop).not.toHaveBeenCalled();
		expect(session.agentRunner).toBeUndefined();
	});

	it("reaps a live WARM runner that errored (guards the orphan regression)", () => {
		const { session, runner } = makeSession(AgentSessionStatus.Error, true);
		reconcileAndReap("s1", {
			getSession: () => session,
			reapWarmInstance: vi.fn(),
		});
		expect(runner.stop).toHaveBeenCalledOnce();
		expect(session.agentRunner).toBeUndefined();
	});

	it("does NOT reap on Complete (held-open / warm-between-turns protection)", () => {
		const { session, runner } = makeSession(AgentSessionStatus.Complete, true);
		reconcileAndReap("s1", {
			getSession: () => session,
			reapWarmInstance: vi.fn(),
		});
		expect(runner.stop).not.toHaveBeenCalled();
		expect(session.agentRunner).toBe(runner);
	});

	it("is idempotent: second call after clear is a no-op", () => {
		const { session, runner } = makeSession(AgentSessionStatus.Error, true);
		const deps = { getSession: () => session, reapWarmInstance: vi.fn() };
		reconcileAndReap("s1", deps);
		reconcileAndReap("s1", deps);
		expect(runner.stop).toHaveBeenCalledOnce();
	});

	it("no-ops for an unknown session", () => {
		expect(() =>
			reconcileAndReap("s1", {
				getSession: () => undefined,
				reapWarmInstance: vi.fn(),
			}),
		).not.toThrow();
	});
});
