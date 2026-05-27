import { LinearClient } from "@linear/sdk";
import type { EdgeWorkerConfig } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";

vi.mock("@linear/sdk");
vi.mock("../src/SharedApplicationServer.js", () => ({
	SharedApplicationServer: vi.fn().mockImplementation(() => ({
		start: vi.fn(),
		registerLinearEventTransport: vi.fn(),
		registerConfigUpdater: vi.fn(),
		registerOAuthCallback: vi.fn(),
	})),
}));

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
		vi.mocked(LinearClient).mockImplementation(() => mockLinearClient);
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
});
