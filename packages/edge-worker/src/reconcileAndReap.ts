import { AgentSessionStatus } from "cyrus-core";

export interface ReconcilableSession {
	status: AgentSessionStatus;
	agentRunner?: { isRunning(): boolean; stop(): void } | undefined;
}

export interface ReconcileAndReapDeps {
	getSession(sessionId: string): ReconcilableSession | undefined;
	reapWarmInstance(sessionId: string): void;
}

/**
 * Reap a session's live runner on an abnormal terminal transition.
 *
 * Intended to run DEFERRED (setImmediate) off the `session_terminal` event so
 * it observes the flipped status and does not re-enter stop() mid result-emit.
 *
 * Reaps only on Error/Stale — NEVER on Complete: held-open (pending-work) and
 * warm-between-turns runners are always Complete, so skipping Complete is the
 * entire carve-out. On Error/Stale the reap is unconditional (a warm runner
 * that errored must be reaped). Idempotent: once agentRunner is cleared, later
 * calls (e.g. the session_terminal double-emit) early-return.
 */
export function reconcileAndReap(
	sessionId: string,
	deps: ReconcileAndReapDeps,
): void {
	const session = deps.getSession(sessionId);
	if (!session) return;
	if (
		session.status !== AgentSessionStatus.Error &&
		session.status !== AgentSessionStatus.Stale
	) {
		return;
	}
	const runner = session.agentRunner;
	if (!runner) return;
	if (runner.isRunning()) runner.stop();
	session.agentRunner = undefined;
	deps.reapWarmInstance(sessionId);
}
