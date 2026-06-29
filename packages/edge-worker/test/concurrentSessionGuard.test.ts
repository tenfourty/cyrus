import { describe, expect, it } from "vitest";
import {
	decideSessionCreationAction,
	KeyedMutex,
} from "../src/concurrentSessionGuard.js";

describe("decideSessionCreationAction", () => {
	it("returns 'create' when the issue has no active session", () => {
		const action = decideSessionCreationAction("issue-1", "sess-new", {
			getActiveSessionsByIssueId: () => [],
		});
		expect(action).toEqual({ action: "create" });
	});

	it("returns 'fold-in' targeting the live session when one already exists", () => {
		const action = decideSessionCreationAction("issue-1", "sess-new", {
			getActiveSessionsByIssueId: () => [
				{ id: "sess-existing", updatedAt: 100 },
			],
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
		});
		expect(action).toEqual({ action: "fold-in", targetSessionId: "newest" });
	});

	it("ignores the session being created itself (idempotent re-entry)", () => {
		// If the new session somehow already got registered, it must not be
		// treated as a pre-existing session to fold into.
		const action = decideSessionCreationAction("issue-1", "sess-new", {
			getActiveSessionsByIssueId: () => [{ id: "sess-new", updatedAt: 100 }],
		});
		expect(action).toEqual({ action: "create" });
	});

	it("folds in (no target) when a sibling is mid-initialization but not yet active", () => {
		// True-concurrency window: the first session's worktree is still being
		// created, so it isn't 'active' yet — but a second trigger must not start
		// its own runner. There's no running runner to deliver to, so no target.
		const action = decideSessionCreationAction("issue-1", "sess-new", {
			getActiveSessionsByIssueId: () => [],
			isIssueInitializing: () => true,
		});
		expect(action).toEqual({ action: "fold-in" });
	});

	it("prefers an active session as the fold-in target over the initializing flag", () => {
		const action = decideSessionCreationAction("issue-1", "sess-new", {
			getActiveSessionsByIssueId: () => [{ id: "live", updatedAt: 100 }],
			isIssueInitializing: () => true,
		});
		expect(action).toEqual({ action: "fold-in", targetSessionId: "live" });
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
