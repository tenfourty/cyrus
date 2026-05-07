import type { CyrusAgentSession, RepositoryConfig } from "cyrus-core";

/**
 * Determines the agent runner's `workingDirectory` (cwd) for a session.
 *
 * Single-repo: `session.workspace.path` IS the worktree → use directly.
 *
 * Multi-repo: `session.workspace.path` is the parent dir of N worktrees;
 * the agent's cwd should be the PRIMARY repo's worktree path so it has a
 * useful git context (running git commands in the parent of N worktrees
 * doesn't operate on any specific repo).
 *
 * Falls back to `session.workspace.path` if `repoPaths` is present but
 * lacks an entry for the primary repo's id.
 */
export function resolveSessionWorkingDirectory(
	session: CyrusAgentSession,
	primaryRepository: RepositoryConfig,
): string {
	if (session.workspace.repoPaths) {
		return (
			session.workspace.repoPaths[primaryRepository.id] ??
			session.workspace.path
		);
	}
	return session.workspace.path;
}
