import { AgentSessionStatus, type CyrusAgentSession } from "cyrus-core";
import type { ResumeFilter, SkipReason } from "../types.js";

/**
 * Sessions whose locally-tracked status is not `Active` cannot be safely
 * respawned: either the prior turn finished cleanly (`Complete`), errored
 * (`Error`), or is in a tracker state cyrus does not currently auto-resume
 * from (`Pending`, `AwaitingInput`, `Stale`).
 *
 * The orchestrator could simply omit these from its sessions source — that's
 * what `AgentSessionManager.getActiveSessions()` does — but that makes the
 * skip silent. Routing the check through the filter pipeline surfaces every
 * non-active session in the run summary's `skipped` array with reason
 * `status-not-active`, so an operator scanning the journal can tell the
 * difference between "no in-flight work to resume" and "we have sessions
 * whose status looks like it was never updated when it should have been."
 *
 * This is a status check only, and status is not a reliable record of user
 * intent — a force-killed runner never emits the result message that would
 * have flipped the status. `StopIntentFilter` covers that case separately.
 */
export class StatusActiveFilter implements ResumeFilter {
	readonly name = "status-active";
	readonly requiresIssueState = false;

	evaluate(session: CyrusAgentSession): SkipReason | null {
		if (session.status === AgentSessionStatus.Active) return null;
		return "status-not-active";
	}
}
