import { describe, expect, it } from "vitest";
import {
	decideSessionCreationAction,
	KeyedMutex,
} from "../src/ConcurrentSessionGuard.js";

describe("decideSessionCreationAction", () => {
	it("returns 'create' when the issue has no active session", () => {
		const action = decideSessionCreationAction("issue-1", "sess-new", {
			getActiveSessionsByIssueId: () => [],
			isSessionLive: () => true,
		});
		expect(action).toEqual({ action: "create" });
	});

	it("returns 'fold-in' targeting the live session when one already exists", () => {
		const action = decideSessionCreationAction("issue-1", "sess-new", {
			getActiveSessionsByIssueId: () => [
				{ id: "sess-existing", updatedAt: 100 },
			],
			isSessionLive: () => true,
		});
		expect(action).toEqual({
			action: "fold-in",
			targetSessionId: "sess-existing",
		});
	});

	it("targets the most-recently-updated active session when several exist", () => {
		const action = decideSessionCreationAction("issue-1", "sess-new", {
			getActiveSessionsByIssueId: () => [
				{ id: "older", updatedAt: 100 },
				{ id: "newest", updatedAt: 300 },
				{ id: "middle", updatedAt: 200 },
			],
			isSessionLive: () => true,
		});
		expect(action).toEqual({ action: "fold-in", targetSessionId: "newest" });
	});

	it("ignores the session being created itself (idempotent re-entry)", () => {
		// If the new session somehow already got registered, it must not be
		// treated as a pre-existing session to fold into.
		const action = decideSessionCreationAction("issue-1", "sess-new", {
			getActiveSessionsByIssueId: () => [{ id: "sess-new", updatedAt: 100 }],
			isSessionLive: () => true,
		});
		expect(action).toEqual({ action: "create" });
	});

	it("folds in (no target) when a sibling is mid-initialization but not yet active", () => {
		// True-concurrency window: the first session's worktree is still being
		// created, so it isn't 'active' yet — but a second trigger must not start
		// its own runner. There's no running runner to deliver to, so no target.
		const action = decideSessionCreationAction("issue-1", "sess-new", {
			getActiveSessionsByIssueId: () => [],
			isSessionLive: () => true,
			isIssueInitializing: () => true,
		});
		expect(action).toEqual({ action: "fold-in" });
	});

	it("prefers an active session as the fold-in target over the initializing flag", () => {
		const action = decideSessionCreationAction("issue-1", "sess-new", {
			getActiveSessionsByIssueId: () => [{ id: "live", updatedAt: 100 }],
			isSessionLive: () => true,
			isIssueInitializing: () => true,
		});
		expect(action).toEqual({ action: "fold-in", targetSessionId: "live" });
	});

	it("returns 'create' for a rehydrated Active-but-dead session (process restart)", () => {
		// restoreState() rehydrates status: Active but never resurrects
		// agentRunner, so isSessionLive must report false for it. Nothing owns
		// the worktree, so the next trigger must start a runner, not decline.
		const action = decideSessionCreationAction("issue-1", "sess-new", {
			getActiveSessionsByIssueId: () => [{ id: "sess-zombie", updatedAt: 100 }],
			isSessionLive: () => false,
		});
		expect(action).toEqual({ action: "create" });
	});

	it("returns 'create' for an Active session whose runner was stopped (unassign-then-reassign)", () => {
		// handleIssueUnassigned stops the runner but never updates status, and
		// the aborted query emits no `result`, so status stays Active with no
		// live runner. A reassignment must still be able to start a runner.
		const action = decideSessionCreationAction("issue-1", "sess-new", {
			getActiveSessionsByIssueId: () => [
				{ id: "sess-stopped", updatedAt: 100 },
			],
			isSessionLive: (id) => id !== "sess-stopped",
		});
		expect(action).toEqual({ action: "create" });
	});

	it("still folds in when the active session genuinely has a live runner", () => {
		const action = decideSessionCreationAction("issue-1", "sess-new", {
			getActiveSessionsByIssueId: () => [{ id: "sess-live", updatedAt: 100 }],
			isSessionLive: (id) => id === "sess-live",
		});
		expect(action).toEqual({ action: "fold-in", targetSessionId: "sess-live" });
	});

	it("falls through to a live sibling when the most-recently-updated one is dead", () => {
		// The newest-by-updatedAt session is a zombie; an older-but-live sibling
		// must still be picked as the fold-in target.
		const action = decideSessionCreationAction("issue-1", "sess-new", {
			getActiveSessionsByIssueId: () => [
				{ id: "sess-live-older", updatedAt: 100 },
				{ id: "sess-zombie-newer", updatedAt: 300 },
			],
			isSessionLive: (id) => id === "sess-live-older",
		});
		expect(action).toEqual({
			action: "fold-in",
			targetSessionId: "sess-live-older",
		});
	});
});

describe("KeyedMutex", () => {
	function deferred() {
		let resolve!: () => void;
		const promise = new Promise<void>((r) => {
			resolve = r;
		});
		return { promise, resolve };
	}

	it("serializes runs that share a key", async () => {
		const mutex = new KeyedMutex();
		const events: string[] = [];
		const gate = deferred();

		const first = mutex.runExclusive("k", async () => {
			events.push("start1");
			await gate.promise;
			events.push("end1");
		});
		const second = mutex.runExclusive("k", async () => {
			events.push("start2");
			events.push("end2");
		});

		// Second must not start while the first holds the lock.
		await Promise.resolve();
		expect(events).toEqual(["start1"]);

		gate.resolve();
		await Promise.all([first, second]);
		expect(events).toEqual(["start1", "end1", "start2", "end2"]);
	});

	it("runs different keys concurrently", async () => {
		const mutex = new KeyedMutex();
		const events: string[] = [];
		const gateA = deferred();

		const a = mutex.runExclusive("a", async () => {
			events.push("startA");
			await gateA.promise;
			events.push("endA");
		});
		const b = mutex.runExclusive("b", async () => {
			events.push("startB");
		});

		await b;
		// B finished while A is still blocked on its gate.
		expect(events).toEqual(["startA", "startB"]);
		gateA.resolve();
		await a;
		expect(events).toEqual(["startA", "startB", "endA"]);
	});

	it("a rejecting run does not wedge later runs on the same key", async () => {
		const mutex = new KeyedMutex();
		await expect(
			mutex.runExclusive("k", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		const result = await mutex.runExclusive("k", async () => "ok");
		expect(result).toBe("ok");
	});

	it("returns the callback's resolved value", async () => {
		const mutex = new KeyedMutex();
		await expect(mutex.runExclusive("k", async () => 42)).resolves.toBe(42);
	});
});
