import { AgentSessionStatus } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { decideSessionCreationAction } from "../src/concurrentSessionGuard.js";

/**
 * Proves the recovery invariant at the decision level: once `reconcileAndReap`
 * flips a crashed/errored session's status away from Active, it is no longer
 * an active fold target. `getActiveSessionsByIssueId` (AgentSessionManager.ts)
 * filters on `status === AgentSessionStatus.Active`, so a re-ping's
 * `decideSessionCreationAction` call sees an empty active-session list for
 * that issue and starts a fresh runner instead of silently folding into the
 * dead session. The full webhook round-trip (reconcile -> reap -> re-ping ->
 * new runner) is covered end-to-end by the F1 test drive in Task 7; this test
 * pins the decision function's behavior on both sides of that invariant.
 */
describe("re-ping after reconcile does not fold into a dead session", () => {
	it("an Error session is not an active fold target → decision is create", () => {
		// After reconcileAndReap flips a crashed session to Error,
		// getActiveSessionsByIssueId (status===Active only) returns [].
		const decision = decideSessionCreationAction("issue-1", "new-session", {
			getActiveSessionsByIssueId: () => [], // Error session excluded by the Active filter
			isIssueInitializing: () => false,
		});
		expect(decision.action).toBe("create");
	});

	it("still folds into a genuinely Active session", () => {
		const decision = decideSessionCreationAction("issue-1", "new-session", {
			getActiveSessionsByIssueId: () => [
				{
					id: "live",
					status: AgentSessionStatus.Active,
					updatedAt: 1,
				} as never,
			],
			isIssueInitializing: () => false,
		});
		expect(decision.action).toBe("fold-in");
	});
});
