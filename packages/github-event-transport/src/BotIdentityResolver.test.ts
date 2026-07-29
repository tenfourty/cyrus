import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type GitHubAppMetadataFetcher,
	resolveGitHubBotIdentityFromApp,
	resolveGitHubBotIdentityFromPat,
} from "./BotIdentityResolver";

describe("resolveGitHubBotIdentityFromPat", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("returns login as both author handle and username", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ id: 99, login: "octocat" }),
		}) as unknown as typeof fetch;

		const identity = await resolveGitHubBotIdentityFromPat({ token: "ghp_xx" });

		expect(identity).toEqual({
			id: 99,
			username: "octocat",
			commentAuthor: "octocat",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"https://api.github.com/user",
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: "token ghp_xx",
				}),
			}),
		);
	});

	it("throws when GitHub returns non-2xx", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 401,
			statusText: "Unauthorized",
			text: async () => "bad creds",
		}) as unknown as typeof fetch;

		await expect(
			resolveGitHubBotIdentityFromPat({ token: "bad" }),
		).rejects.toThrow(/401/);
	});
});

describe("resolveGitHubBotIdentityFromApp", () => {
	it("returns slug with [bot] suffix as commentAuthor", async () => {
		const fetchAppMetadata: GitHubAppMetadataFetcher = vi
			.fn()
			.mockResolvedValue({ id: 7, slug: "repo-a-agent-app" });

		const identity = await resolveGitHubBotIdentityFromApp({
			fetchAppMetadata,
		});

		expect(identity).toEqual({
			id: 7,
			username: "repo-a-agent-app",
			commentAuthor: "repo-a-agent-app[bot]",
		});
		expect(fetchAppMetadata).toHaveBeenCalled();
	});

	it("propagates errors from the metadata fetcher", async () => {
		const fetchAppMetadata: GitHubAppMetadataFetcher = vi
			.fn()
			.mockRejectedValue(new Error("private key missing"));

		await expect(
			resolveGitHubBotIdentityFromApp({ fetchAppMetadata }),
		).rejects.toThrow(/private key missing/);
	});
});
