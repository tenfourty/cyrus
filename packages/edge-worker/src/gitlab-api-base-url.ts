/**
 * Derive the GitLab API base URL (origin) from a list of repository configs.
 *
 * Cyrus assumes a single GitLab host per instance — picks the first repo
 * with a `gitlabUrl` field set and returns its origin (e.g.
 * `https://gitlab.example.com`). Used by `GitLabCommentService` for
 * posting MR replies, and shared with any future consumer that needs
 * the same self-hosted-aware base URL rather than duplicating the
 * derivation logic inline.
 *
 * Returns `undefined` when no repo has a `gitlabUrl` or when the URL is
 * malformed; callers fall back to the SaaS default (gitlab.com).
 */
export interface RepoWithMaybeGitlabUrl {
	gitlabUrl?: string;
	[key: string]: unknown;
}

export function deriveGitlabApiBaseUrl(
	repositories: readonly RepoWithMaybeGitlabUrl[],
): string | undefined {
	for (const repo of repositories) {
		if (!repo.gitlabUrl) continue;
		try {
			return new URL(repo.gitlabUrl).origin;
		} catch {
			return undefined;
		}
	}
	return undefined;
}
