/**
 * Resolve the GitLab user identity that owns a Personal Access Token.
 *
 * Used to determine the bot's own GitLab identity at startup so the EdgeWorker
 * can drop self-authored note webhooks unconditionally — the deployment's PAT
 * may belong to a human user (the "PAT-as-human" pattern), in which case there
 * is no structural distinction between Cyrus's comments and the human's, and a
 * self-feedback loop is the default without explicit configuration.
 */
export interface GitLabBotIdentity {
	/** GitLab numeric user id — primary match key, immutable across username changes */
	id: number;
	/** GitLab username — used for display and as the @mention handle */
	username: string;
}

export interface ResolveGitLabBotIdentityOptions {
	token: string;
	/** GitLab API base URL. Defaults to https://gitlab.com for SaaS. */
	apiBaseUrl?: string;
}

export async function resolveGitLabBotIdentity(
	options: ResolveGitLabBotIdentityOptions,
): Promise<GitLabBotIdentity> {
	const base = options.apiBaseUrl ?? "https://gitlab.com";
	const url = `${base}/api/v4/user`;

	const response = await fetch(url, {
		method: "GET",
		headers: {
			"PRIVATE-TOKEN": options.token,
			Accept: "application/json",
		},
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(
			`Failed to resolve GitLab bot identity: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`,
		);
	}

	const data = (await response.json()) as { id?: number; username?: string };
	if (typeof data.id !== "number" || typeof data.username !== "string") {
		throw new Error(
			"GitLab /api/v4/user response missing required id or username fields",
		);
	}
	return { id: data.id, username: data.username };
}
