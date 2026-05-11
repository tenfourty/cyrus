import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveGitLabBotIdentity } from "./BotIdentityResolver";

describe("resolveGitLabBotIdentity", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("returns id and username from GET /api/v4/user", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ id: 42, username: "agentHost-bot" }),
		}) as unknown as typeof fetch;

		const identity = await resolveGitLabBotIdentity({
			token: "glpat-xxx",
		});

		expect(identity).toEqual({ id: 42, username: "agentHost-bot" });
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"https://gitlab.com/api/v4/user",
			expect.objectContaining({
				headers: expect.objectContaining({ "PRIVATE-TOKEN": "glpat-xxx" }),
			}),
		);
	});

	it("uses custom apiBaseUrl when provided (self-hosted GitLab)", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ id: 1, username: "u" }),
		}) as unknown as typeof fetch;

		await resolveGitLabBotIdentity({
			token: "t",
			apiBaseUrl: "https://gitlab.example.com",
		});

		expect(globalThis.fetch).toHaveBeenCalledWith(
			"https://gitlab.example.com/api/v4/user",
			expect.anything(),
		);
	});

	it("throws with status when GitLab returns non-2xx", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 401,
			statusText: "Unauthorized",
			text: async () => "invalid token",
		}) as unknown as typeof fetch;

		await expect(
			resolveGitLabBotIdentity({ token: "bad" }),
		).rejects.toThrow(/401/);
	});

	it("throws when payload is missing required fields", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ id: 7 }),
		}) as unknown as typeof fetch;

		await expect(resolveGitLabBotIdentity({ token: "t" })).rejects.toThrow(
			/username/,
		);
	});
});
