import type { CyrusAgentSession, RepositoryConfig } from "cyrus-core";
import { composeAllowedDirectoriesForSession } from "./composeAllowedDirectories.js";

export interface ComposeInitialAllowedDirectoriesInput {
	session: CyrusAgentSession;
	repositories: RepositoryConfig[];
	attachmentsDir: string;
	/**
	 * Extra paths to append beyond the participating repos. Used by callers
	 * that need to grant the agent access to additional workspace dirs (e.g.
	 * a parent session passing child workspace dirs for feedback delivery).
	 */
	additionalAllowedDirectories?: string[];
	getGitMetadataDirectories: (workingDirectory: string) => string[];
}

/**
 * Compose the `allowedDirectories` list for an agent session spanning one
 * or more repositories. Used by both the initial-creation path
 * (`createCyrusAgentSession`) and the resume path (`resumeAgentSession`).
 *
 * Wraps `composeAllowedDirectoriesForSession` so multi-repo sessions get
 * worktree paths from `session.workspace.repoPaths` AND every repo's
 * canonical source path (the latter via `additionalAllowedDirectories`
 * for non-primary repos). Any extra paths supplied by the caller are
 * merged in alongside.
 */
export function composeInitialAllowedDirectories(
	input: ComposeInitialAllowedDirectoriesInput,
): string[] {
	const [primary, ...secondaries] = input.repositories;
	if (!primary) {
		return [input.attachmentsDir];
	}

	const secondarySourcePaths = secondaries.map((r) => r.repositoryPath);
	const extra = input.additionalAllowedDirectories ?? [];

	return composeAllowedDirectoriesForSession({
		session: input.session,
		primaryRepository: primary,
		attachmentsDir: input.attachmentsDir,
		additionalAllowedDirectories: [...secondarySourcePaths, ...extra],
		getGitMetadataDirectories: input.getGitMetadataDirectories,
	});
}
