import { AgentSessionStatus } from "cyrus-core";

/**
 * Terminal statuses for a `CyrusAgentSession` — once a session reaches one of
 * these, `AgentSessionManager.updateSessionStatus` fires `session_terminal`
 * (persistence + reap hooks) and no further turns are expected without an
 * explicit resume (`markSessionResuming`, which flips back to `Active`).
 *
 * Extracted from the inline gate that used to live in `updateSessionStatus`
 * so `reconcileTerminatedRunner`'s out-of-band-termination notice (see
 * `shouldPostTerminalNotice`) can reuse the same definition instead of
 * re-deriving it.
 */
export function isTerminalSessionStatus(status: AgentSessionStatus): boolean {
	return (
		status === AgentSessionStatus.Complete ||
		status === AgentSessionStatus.Error ||
		status === AgentSessionStatus.Stale
	);
}

/**
 * Decides whether an out-of-band runner termination (crash/OOM/SIGTERM, or a
 * genuine thrown error) should post a visible "this session stopped
 * unexpectedly" notice to the timeline.
 *
 * - `status` must be sampled BEFORE `markSessionStopped` flips it to `Error`
 *   — a session that was already terminal (e.g. a second termination signal
 *   racing the first) doesn't need a second notice.
 * - `undefined` status means the session is unknown to the caller; treat
 *   that as "don't post" rather than assuming non-terminal.
 * - Gated to Linear only (`trackerId === "linear"`) — this posts through the
 *   tracker-agnostic `createErrorActivity` sink, but the coarse-reason
 *   notice is only meaningful where Cyrus owns visible turn-by-turn
 *   timeline activities today.
 *
 * Self-resets across a re-ping: `markSessionResuming` sets status back to
 * `Active`, so a subsequent failure after re-prompting evaluates `preStatus`
 * as `Active` again and posts again. No sticky "already notified" flag.
 */
export function shouldPostTerminalNotice(
	status: AgentSessionStatus | undefined,
	trackerId: string | undefined,
): boolean {
	return (
		status !== undefined &&
		!isTerminalSessionStatus(status) &&
		trackerId === "linear"
	);
}
