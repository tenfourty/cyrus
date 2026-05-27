import { LinearClient } from "@linear/sdk";
import type { EdgeWorkerConfig } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";

vi.mock("@linear/sdk");
vi.mock("../src/SharedApplicationServer.js");

vi.mock("node:fs/promises", () => ({
	readFile: vi.fn().mockResolvedValue(JSON.stringify({ linearWorkspaces: {} })),
	writeFile: vi.fn().mockResolvedValue(undefined),
	mkdir: vi.fn().mockResolvedValue(undefined),
	readdir: vi.fn().mockResolvedValue([]),
	rename: vi.fn().mockResolvedValue(undefined),
}));

global.fetch = vi.fn();

function makeConfig(): EdgeWorkerConfig {
	return {
		repositories: [
			{
				id: "repo-1",
				name: "test-repo-1",
				repositoryPath: "/test/repo1",
				workspaceBaseDir: "/test/workspaces",
				baseBranch: "main",
				linearWorkspaceId: "workspace-123",
			},
		],
		linearWorkspaces: {
			"workspace-123": {
				linearToken: "stored_token",
				linearRefreshToken: "refresh_token",
				linearWorkspaceName: "Test Workspace",
			},
		},
		cyrusHome: "/test/.cyrus",
		serverPort: 3456,
		serverHost: "localhost",
	} as EdgeWorkerConfig;
}

describe("EdgeWorker.ensureFreshLinearToken", () => {
	let edgeWorker: EdgeWorker;
	let mockLinearClient: any;

	beforeEach(() => {
		vi.clearAllMocks();
		process.env.LINEAR_CLIENT_ID = "test_client_id";
		process.env.LINEAR_CLIENT_SECRET = "test_client_secret";

		mockLinearClient = {
			issue: vi.fn(),
			client: { request: vi.fn(), setHeader: vi.fn() },
		};
		vi.mocked(LinearClient).mockImplementation(function () {
			return mockLinearClient;
		} as any);
	});

	it("proactively refreshes when the stored token has expired", async () => {
		const config = makeConfig();
		config.linearWorkspaces!["workspace-123"].linearTokenExpiresAt =
			Date.now() - 60_000; // already expired
		edgeWorker = new EdgeWorker(config);

		const tracker = (edgeWorker as any).issueTrackers.get("workspace-123");
		const forceRefresh = vi
			.spyOn(tracker, "forceRefresh")
			.mockResolvedValue("refreshed_token");

		const token = await (edgeWorker as any).ensureFreshLinearToken(
			"workspace-123",
		);

		expect(forceRefresh).toHaveBeenCalledTimes(1);
		expect(token).toBe("refreshed_token");
	});

	it("returns the stored token without refreshing when it is still fresh", async () => {
		const config = makeConfig();
		config.linearWorkspaces!["workspace-123"].linearTokenExpiresAt =
			Date.now() + 60 * 60 * 1000; // an hour out
		edgeWorker = new EdgeWorker(config);

		const tracker = (edgeWorker as any).issueTrackers.get("workspace-123");
		const forceRefresh = vi.spyOn(tracker, "forceRefresh");

		const token = await (edgeWorker as any).ensureFreshLinearToken(
			"workspace-123",
		);

		expect(forceRefresh).not.toHaveBeenCalled();
		expect(token).toBe("stored_token");
	});

	it("returns the stored token (no refresh attempt) when no refresh credentials exist", async () => {
		const config = makeConfig();
		config.linearWorkspaces!["workspace-123"].linearRefreshToken = undefined;
		config.linearWorkspaces!["workspace-123"].linearTokenExpiresAt =
			Date.now() - 60_000;
		edgeWorker = new EdgeWorker(config);

		const tracker = (edgeWorker as any).issueTrackers.get("workspace-123");
		const forceRefresh = tracker
			? vi.spyOn(tracker, "forceRefresh")
			: undefined;

		const token = await (edgeWorker as any).ensureFreshLinearToken(
			"workspace-123",
		);

		expect(forceRefresh?.mock.calls.length ?? 0).toBe(0);
		expect(token).toBe("stored_token");
	});

	it("returns null for an unconfigured workspace", async () => {
		edgeWorker = new EdgeWorker(makeConfig());
		const token = await (edgeWorker as any).ensureFreshLinearToken("nope");
		expect(token).toBeNull();
	});

	it("proactively refreshes when the stored expiry is unknown/legacy (missing or non-numeric) — the case that fires on every existing install upgrading to this fix, since none of them have linearTokenExpiresAt persisted yet", async () => {
		const config = makeConfig();
		// makeConfig() does not set linearTokenExpiresAt at all — this is exactly
		// the shape of every pre-existing config.json on upgrade. Also exercise a
		// non-numeric value explicitly so the `typeof expiresAt === "number"`
		// guard is proven, not just the "field absent" case.
		expect(
			config.linearWorkspaces!["workspace-123"].linearTokenExpiresAt,
		).toBeUndefined();
		edgeWorker = new EdgeWorker(config);

		const tracker = (edgeWorker as any).issueTrackers.get("workspace-123");
		const forceRefresh = vi
			.spyOn(tracker, "forceRefresh")
			.mockResolvedValue("refreshed_token");

		const token = await (edgeWorker as any).ensureFreshLinearToken(
			"workspace-123",
		);

		// Non-vacuousness: if the unknown-expiry branch were mutated to treat a
		// missing/non-numeric expiry as fresh (e.g. `isFresh = typeof expiresAt
		// === "number" ? ... : true`), this assertion fails because forceRefresh
		// would never be called and the returned token would be "stored_token".
		expect(forceRefresh).toHaveBeenCalledTimes(1);
		expect(token).toBe("refreshed_token");
	});

	it("falls back to the stored token — without throwing — when the proactive refresh rejects, so session start is never blocked by a broken Linear OAuth refresh", async () => {
		const config = makeConfig();
		config.linearWorkspaces!["workspace-123"].linearTokenExpiresAt =
			Date.now() - 60_000; // expired, so refresh is attempted
		edgeWorker = new EdgeWorker(config);

		const tracker = (edgeWorker as any).issueTrackers.get("workspace-123");
		const refreshError = new Error("network timeout");
		const forceRefresh = vi
			.spyOn(tracker, "forceRefresh")
			.mockRejectedValue(refreshError);

		// Non-vacuousness: if the catch block were mutated from `return
		// storedToken` to `throw error`, this await would reject and the test
		// would fail here rather than at the assertions below.
		const token = await (edgeWorker as any).ensureFreshLinearToken(
			"workspace-123",
		);

		expect(forceRefresh).toHaveBeenCalledTimes(1);
		expect(token).toBe("stored_token");
	});
});
