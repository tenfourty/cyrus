import type { CyrusAgentSession } from "cyrus-core";
import type { ResumeFilter, SkipReason } from "../types.js";

/**
 * Never respawn a session the user deliberately stopped.
 *
 * `session.status` is NOT sufficient for this. A stop that hits the
 * non-interruptible branch force-kills the runner; the SDK then throws an
 * `AbortError` which the runner swallows without emitting a result message,
 * so `AgentSessionManager.handleResultMessage` — the only thing that flips
 * status on a stop — never runs. The session is still `Active` when
 * `EdgeWorker.stop()` saves state, and that is what lands on disk.
 *
 * `AgentSessionManager.requestSessionStop()` therefore stamps
 * `session.stopRequestedAt` on the session record itself, which persists
 * with the rest of the session. This filter reads that stamp, so the stop
 * is honored across restarts regardless of what status ended up being
 * recorded. A subsequent user prompt clears the stamp
 * (`clearStopIntent`), making the session eligible again.
 */
export class StopIntentFilter implements ResumeFilter {
	readonly name = "stop-intent";
	readonly requiresIssueState = false;

	evaluate(session: CyrusAgentSession): SkipReason | null {
		return session.stopRequestedAt !== undefined ? "user-stopped" : null;
	}
}
