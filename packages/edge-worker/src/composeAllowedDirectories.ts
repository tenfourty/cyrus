import type { CyrusAgentSession, RepositoryConfig } from "cyrus-core";

export interface ComposeAllowedDirectoriesInput {
	session: CyrusAgentSession;
	primaryRepository: RepositoryConfig;
	attachmentsDir: string;
	additionalAllowedDirectories: string[];
	/** Injected dependency: returns git metadata dirs (e.g. .git, worktree refs) for a working dir */
	getGitMetadataDirectories: (workingDirectory: string) => string[];
}

/**
 * Compose the `allowedDirectories` list passed to the agent runner SDK
 * when a session is resumed.
 *
 * Single-repo (no `session.workspace.repoPaths`): preserves prior behavior —
 * the primary repo's source path, plus git metadata directories resolved
 * from `session.workspace.path` (which IS the worktree). The worktree
 * itself becomes the agent's cwd and is implicitly accessible.
 *
 * Multi-repo (`session.workspace.repoPaths` populated): adds EVERY worktree
 * path explicitly so the agent can read and write across all participating
 * repositories, plus per-worktree git metadata dirs. `session.workspace.path`
 * is the parent of the worktrees and is NOT itself a git worktree, so its
 * metadata is not collected.
 *
 * Always merges in `attachmentsDir` and `additionalAllowedDirectories`.
 * Result is deduplicated.
 */
export function composeAllowedDirectoriesForSession(
	input: ComposeAllowedDirectoriesInput,
): string[] {
	const {
		session,
		primaryRepository,
		attachmentsDir,
		additionalAllowedDirectories,
		getGitMetadataDirectories,
	} = input;

	const dirs = new Set<string>([
		attachmentsDir,
		primaryRepository.repositoryPath,
		...additionalAllowedDirectories,
	]);

	if (session.workspace.repoPaths) {
		for (const worktreePath of Object.values(session.workspace.repoPaths)) {
			dirs.add(worktreePath);
			for (const metaDir of getGitMetadataDirectories(worktreePath)) {
				dirs.add(metaDir);
			}
		}
	} else {
		for (const metaDir of getGitMetadataDirectories(session.workspace.path)) {
			dirs.add(metaDir);
		}
	}

	return [...dirs];
}
