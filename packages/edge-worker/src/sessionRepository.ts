import type { RepositoryConfig } from "cyrus-core";

export interface ResolveSessionRepositoryDeps {
	sessionRepositories: Map<string, string>;
	repositories: Map<string, RepositoryConfig>;
}

/** Resolve the RepositoryConfig a session belongs to, or undefined if unknown. */
export function resolveSessionRepository(
	sessionId: string,
	deps: ResolveSessionRepositoryDeps,
): RepositoryConfig | undefined {
	const repoId = deps.sessionRepositories.get(sessionId);
	if (!repoId) return undefined;
	return deps.repositories.get(repoId);
}
