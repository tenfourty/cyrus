import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	LinearIssueTrackerService,
	type LinearOAuthConfig,
} from "../src/LinearIssueTrackerService.js";

/**
 * Build a fake LinearClient whose underlying GraphQL `.client` exposes the
 * request/setHeader surface the refresh interceptor patches.
 */
function makeFakeLinearClient() {
	return {
		client: {
			request: vi.fn(),
			setHeader: vi.fn(),
		},
	} as any;
}

describe("LinearIssueTrackerService proactive token refresh", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Reset the static shared refresh-token map between tests.
		(LinearIssueTrackerService as any).workspaceRefreshTokens = new Map();
		(LinearIssueTrackerService as any).pendingRefreshes = new Map();
		global.fetch = vi.fn();
	});

	afterEach(() => {
		// vitest config has no `restoreMocks`, and `vi.clearAllMocks()` above only
		// clears call history — it does not restore spied implementations (e.g.
		// `vi.spyOn(Date, "now")` below). Restore explicitly so a mocked `Date.now`
		// can't leak into tests added later in this file.
		vi.restoreAllMocks();
	});

	it("forceRefresh() exchanges the refresh token and returns the new access token without needing a 401", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				access_token: "fresh_access_token",
				refresh_token: "rotated_refresh_token",
				expires_in: 3600,
			}),
		} as any);

		const client = makeFakeLinearClient();
		const oauthConfig: LinearOAuthConfig = {
			clientId: "client_id",
			clientSecret: "client_secret",
			refreshToken: "stored_refresh_token",
			workspaceId: "workspace-1",
		};
		const service = new LinearIssueTrackerService(client, oauthConfig);

		const token = await service.forceRefresh();

		expect(token).toBe("fresh_access_token");
		expect(global.fetch).toHaveBeenCalledWith(
			"https://api.linear.app/oauth/token",
			expect.objectContaining({ method: "POST" }),
		);
		// The new token is pushed onto the GraphQL client header.
		expect(client.client.setHeader).toHaveBeenCalledWith(
			"Authorization",
			"Bearer fresh_access_token",
		);
	});

	it("passes the absolute token expiry (epoch ms) to onTokenRefresh so callers can persist it", async () => {
		const nowMs = 1_000_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(nowMs);
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				access_token: "fresh_access_token",
				refresh_token: "rotated_refresh_token",
				expires_in: 3600,
			}),
		} as any);

		const onTokenRefresh = vi.fn();
		const client = makeFakeLinearClient();
		const service = new LinearIssueTrackerService(client, {
			clientId: "client_id",
			clientSecret: "client_secret",
			refreshToken: "stored_refresh_token",
			workspaceId: "workspace-1",
			onTokenRefresh,
		});

		await service.forceRefresh();

		expect(onTokenRefresh).toHaveBeenCalledWith({
			accessToken: "fresh_access_token",
			refreshToken: "rotated_refresh_token",
			expiresAt: nowMs + 3600 * 1000,
		});
	});

	it("bounds the refresh request with an abort signal so it cannot hang indefinitely", async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				access_token: "fresh_access_token",
				refresh_token: "rotated_refresh_token",
				expires_in: 3600,
			}),
		} as any);

		const client = makeFakeLinearClient();
		const service = new LinearIssueTrackerService(client, {
			clientId: "client_id",
			clientSecret: "client_secret",
			refreshToken: "stored_refresh_token",
			workspaceId: "workspace-1",
		});

		await service.forceRefresh();

		expect(global.fetch).toHaveBeenCalledWith(
			"https://api.linear.app/oauth/token",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it("propagates a timed-out/rejected refresh as a rejection rather than hanging or swallowing it, so callers can fall back to the stored token", async () => {
		// Simulate what `AbortSignal.timeout(...)` produces on a real fetch: the
		// request promise rejects with a DOMException/AbortError.
		const timeoutError = new DOMException(
			"The operation was aborted due to timeout",
			"TimeoutError",
		);
		vi.mocked(global.fetch).mockRejectedValueOnce(timeoutError);

		const client = makeFakeLinearClient();
		const service = new LinearIssueTrackerService(client, {
			clientId: "client_id",
			clientSecret: "client_secret",
			refreshToken: "stored_refresh_token",
			workspaceId: "workspace-1",
		});

		await expect(service.forceRefresh()).rejects.toThrow(timeoutError.message);
		// The client must not have been left with a stale/failed Authorization
		// header change — refresh failure should be a pure no-op on the client.
		expect(client.client.setHeader).not.toHaveBeenCalled();
	});
});
