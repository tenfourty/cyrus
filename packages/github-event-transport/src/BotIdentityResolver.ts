/**
 * Resolve the GitHub identity that Cyrus posts comments under, so the
 * EdgeWorker can drop self-authored webhook deliveries unconditionally.
 *
 * Two auth modes are supported:
 *
 * - GitHub App (recommended): comment author appears as `<slug>[bot]`. The App
 *   slug is fetched once via `GET /app` using the existing JWT-minted token
 *   provider. Loop-safe by structure (no human can author a `[bot]` comment),
 *   but we still resolve so we can compare by id and surface the identity in
 *   status output.
 *
 * - PAT: comment author is the PAT owner. In the "PAT-as-human" deployment
 *   pattern (a real user's PAT is used as the bot's credential), there is no
 *   structural distinction between Cyrus's comments and the user's, so
 *   resolution is the only thing that prevents a self-feedback loop.
 */
export interface GitHubBotIdentity {
	/** GitHub numeric user/app id — primary match key */
	id: number;
	/** Human-readable username (PAT login or App slug) */
	username: string;
	/** Author handle as it appears in webhook payloads (`login` field) */
	commentAuthor: string;
}

export interface ResolveGitHubBotIdentityFromPatOptions {
	token: string;
	/** GitHub API base URL. Defaults to https://api.github.com. */
	apiBaseUrl?: string;
}

export async function resolveGitHubBotIdentityFromPat(
	options: ResolveGitHubBotIdentityFromPatOptions,
): Promise<GitHubBotIdentity> {
	const base = options.apiBaseUrl ?? "https://api.github.com";
	const response = await fetch(`${base}/user`, {
		method: "GET",
		headers: {
			Authorization: `token ${options.token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(
			`Failed to resolve GitHub PAT identity: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`,
		);
	}

	const data = (await response.json()) as { id?: number; login?: string };
	if (typeof data.id !== "number" || typeof data.login !== "string") {
		throw new Error(
			"GitHub /user response missing required id or login fields",
		);
	}
	return {
		id: data.id,
		username: data.login,
		commentAuthor: data.login,
	};
}

export interface GitHubAppMetadata {
	id: number;
	slug: string;
}

export type GitHubAppMetadataFetcher = () => Promise<GitHubAppMetadata>;

export interface ResolveGitHubBotIdentityFromAppOptions {
	fetchAppMetadata: GitHubAppMetadataFetcher;
}

export async function resolveGitHubBotIdentityFromApp(
	options: ResolveGitHubBotIdentityFromAppOptions,
): Promise<GitHubBotIdentity> {
	const meta = await options.fetchAppMetadata();
	return {
		id: meta.id,
		username: meta.slug,
		commentAuthor: `${meta.slug}[bot]`,
	};
}
