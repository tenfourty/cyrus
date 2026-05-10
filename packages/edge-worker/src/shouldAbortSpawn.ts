import { existsSync } from "node:fs";
import type { CyrusAgentSession, ILogger } from "cyrus-core";

export type SpawnAbortReason =
	| "session-removed"
	| "stop-requested"
	| "worktree-missing";

interface AgentSessionManagerLike {
	getSession(sessionId: string): CyrusAgentSession | undefined;
	isStopRequested(sessionId: string): boolean;
}

export interface ShouldAbortSpawnInput {
	session: CyrusAgentSession;
	agentSessionManager: AgentSessionManagerLike;
	logger: ILogger;
}

/**
 * Decide whether a runner spawn should be aborted just before
 * `runner.start()`.
 *
 * Background: webhook handling tracks the session synchronously
 * (`AgentSessionManager.trackSession`) but spawns the SDK subprocess
 * asynchronously after a multi-step config build (8s+ in the wild). During
 * that window the issue can move to a terminal state, the
 * `IssueStateChange` cleanup pipeline can request a stop, remove the
 * session record, and `git worktree remove` the workspace. Without this
 * check the runner happily spawns into a deleted workspace, gets a
 * Claude session ID, and runs to apparent success — leaving persisted
 * state that says "active" while the disk has been swept clean.
 *
 * Checks (cheapest first):
 *
 * 1. **session-removed** — `AgentSessionManager.getSession(id)` returns
 *    `undefined`. The cleanup pipeline already removed the session from
 *    the in-memory map; spawning would attach a runner to a record that
 *    no longer exists.
 * 2. **stop-requested** — Cleanup set the stop flag but hasn't yet
 *    removed the session (a tighter race window inside cleanup's
 *    two-pass loop). Non-consuming check; the cleanup pipeline owns the
 *    flag's lifecycle.
 * 3. **worktree-missing** — A defense-in-depth filesystem probe. The
 *    workspace path (or any sibling worktree for multi-repo) was deleted
 *    by an external actor (operator, manual cleanup, anything that did
 *    not go through the IssueStateChange flow). Refuse to spawn into a
 *    workspace that isn't there.
 *
 * Returns `null` if the spawn should proceed.
 */
export function shouldAbortSpawn(
	input: ShouldAbortSpawnInput,
): SpawnAbortReason | null {
	const { session, agentSessionManager, logger } = input;
	const log = logger.withContext({ sessionId: session.id });

	if (!agentSessionManager.getSession(session.id)) {
		log.info(
			"Aborting runner spawn: session was removed (likely issue-terminal cleanup ran during async config build)",
		);
		return "session-removed";
	}

	if (agentSessionManager.isStopRequested(session.id)) {
		log.info(
			"Aborting runner spawn: stop was requested for this session before the runner could start",
		);
		return "stop-requested";
	}

	const missing = findMissingWorktreePath(session);
	if (missing) {
		log.error(
			`Aborting runner spawn: workspace path missing on disk (${missing}) — refusing to start a session in a deleted worktree`,
		);
		return "worktree-missing";
	}

	return null;
}

function findMissingWorktreePath(session: CyrusAgentSession): string | null {
	const repoPaths = session.workspace.repoPaths;
	if (repoPaths && Object.keys(repoPaths).length > 0) {
		for (const path of Object.values(repoPaths)) {
			if (!existsSync(path)) return path;
		}
		return null;
	}
	return existsSync(session.workspace.path) ? null : session.workspace.path;
}
