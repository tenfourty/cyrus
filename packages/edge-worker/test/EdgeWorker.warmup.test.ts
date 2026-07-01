import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

// Mock dependencies BEFORE imports. Preserve the real cyrus-claude-runner
// exports (buildBaseSessionEnv, tool helpers, types) — only stub the runner
// class, which warmup never instantiates.
vi.mock("cyrus-claude-runner", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	ClaudeRunner: vi.fn(),
}));
vi.mock("@linear/sdk");
vi.mock("cyrus-linear-event-transport");
vi.mock("../src/SharedApplicationServer.js");
vi.mock("../src/AgentSessionManager.js");
vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	mkdir: vi.fn(),
	rename: vi.fn(),
}));

// Preserve the real SDK module, but capture startup() so we can assert the
// options the warmup path passes to it.
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	startup: vi.fn(),
}));

import { startup } from "@anthropic-ai/claude-agent-sdk";
import { LinearClient } from "@linear/sdk";
import { AgentSessionStatus } from "cyrus-core";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig } from "../src/types.js";

describe("EdgeWorker - warm instance leak prevention", () => {
	let edgeWorker: EdgeWorker;
	let mockConfig: EdgeWorkerConfig;
	let sessions: any[];
	let mockWarm: { close: ReturnType<typeof vi.fn> };

	function injectSession(session: any, repoId = "repo-a") {
		sessions.push(session);
		(edgeWorker as any).sessionRepositories.set(session.id, repoId);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		sessions = [];
		mockWarm = { close: vi.fn() };

		mockConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [
				{
					id: "repo-a",
					name: "Repo A",
					repositoryPath: "/test/repo-a",
					workspaceBaseDir: "/test/workspaces-a",
					baseBranch: "main",
					linearWorkspaceId: "test-workspace",
					isActive: true,
				},
			],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
		};

		vi.mocked(SharedApplicationServer).mockImplementation(function () {
			return {
				start: vi.fn().mockResolvedValue(undefined),
				stop: vi.fn().mockResolvedValue(undefined),
				getFastifyInstance: vi.fn().mockReturnValue({ post: vi.fn() }),
				getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
				setWebhookHandler: vi.fn(),
				setOAuthCallbackHandler: vi.fn(),
			};
		} as any);

		vi.mocked(AgentSessionManager).mockImplementation(function () {
			return {
				getAllSessions: vi.fn(() => sessions),
				on: vi.fn(),
			};
		} as any);

		vi.mocked(LinearEventTransport).mockImplementation(function () {
			return { register: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };
		} as any);

		vi.mocked(LinearClient).mockImplementation(function () {
			return {
				viewer: vi.fn().mockResolvedValue({ id: "u", email: "u@x.com" }),
			};
		} as any);

		edgeWorker = new EdgeWorker(mockConfig);

		(edgeWorker as any).mcpConfigService.buildMcpConfig = vi
			.fn()
			.mockResolvedValue({});
		(edgeWorker as any).mcpConfigService.buildMergedMcpConfigPath = vi
			.fn()
			.mockReturnValue(undefined);

		vi.mocked(startup).mockResolvedValue(mockWarm as never);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("warms a single-repo session with the workspace path as cwd", async () => {
		injectSession({
			id: "sess-single",
			claudeSessionId: "single-id",
			updatedAt: 1,
			status: AgentSessionStatus.Active,
			workspace: { path: "/test/workspaces-a/ENG-1" },
			issueContext: { issueIdentifier: "ENG-1" },
		});

		await (edgeWorker as any).warmupRecentSessions();

		expect(startup).toHaveBeenCalledTimes(1);
		const passed = vi.mocked(startup).mock.calls[0][0] as any;
		expect(passed.options.cwd).toBe("/test/workspaces-a/ENG-1");
	});

	it("does not warm sessions in a terminal status (Complete)", async () => {
		injectSession({
			id: "sess-complete",
			claudeSessionId: "complete-id",
			updatedAt: 5,
			status: AgentSessionStatus.Complete,
			workspace: { path: "/test/workspaces-a/ENG-1" },
			issueContext: { issueIdentifier: "ENG-1" },
		});
		injectSession({
			id: "sess-active",
			claudeSessionId: "active-id",
			updatedAt: 4,
			status: AgentSessionStatus.Active,
			workspace: { path: "/test/workspaces-a/ENG-2" },
			issueContext: { issueIdentifier: "ENG-2" },
		});

		await (edgeWorker as any).warmupRecentSessions();

		expect(startup).toHaveBeenCalledTimes(1);
		expect(vi.mocked(startup).mock.calls[0][0].options.resume).toBe(
			"active-id",
		);
		expect((edgeWorker as any).warmInstances.size).toBe(1);
		expect((edgeWorker as any).warmInstances.has("sess-complete")).toBe(false);
	});

	it("does not warm sessions in a terminal status (Error)", async () => {
		injectSession({
			id: "sess-error",
			claudeSessionId: "error-id",
			updatedAt: 5,
			status: AgentSessionStatus.Error,
			workspace: { path: "/test/workspaces-a/ENG-3" },
			issueContext: { issueIdentifier: "ENG-3" },
		});

		await (edgeWorker as any).warmupRecentSessions();

		expect(startup).not.toHaveBeenCalled();
		expect((edgeWorker as any).warmInstances.size).toBe(0);
	});

	it("reaps an unconsumed warm instance after the idle TTL (subprocess killed)", async () => {
		vi.useFakeTimers();
		injectSession({
			id: "sess-orphan",
			claudeSessionId: "orphan-id",
			updatedAt: 5,
			status: AgentSessionStatus.Active,
			workspace: { path: "/test/workspaces-a/ENG-4" },
			issueContext: { issueIdentifier: "ENG-4" },
		});

		await (edgeWorker as any).warmupRecentSessions();

		expect((edgeWorker as any).warmInstances.size).toBe(1);
		expect(mockWarm.close).not.toHaveBeenCalled();

		// Advance past the idle TTL (10 min default).
		await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

		expect(mockWarm.close).toHaveBeenCalledTimes(1);
		expect((edgeWorker as any).warmInstances.size).toBe(0);
		expect((edgeWorker as any).warmInstanceExpiryTimers.size).toBe(0);
	});

	it("cancels the idle-expiry timer when a warm instance is consumed by a prompt", async () => {
		vi.useFakeTimers();
		injectSession({
			id: "sess-consumed",
			claudeSessionId: "consumed-id",
			updatedAt: 5,
			status: AgentSessionStatus.Active,
			workspace: { path: "/test/workspaces-a/ENG-5" },
			issueContext: { issueIdentifier: "ENG-5" },
		});

		await (edgeWorker as any).warmupRecentSessions();

		// Simulate the consume path (buildAgentRunnerConfig attaches the warm session).
		(edgeWorker as any).warmInstances.delete("sess-consumed");
		(edgeWorker as any).cancelWarmInstanceExpiry("sess-consumed");

		// Advance past TTL — close() must NOT fire because the instance was
		// consumed (ownership transferred to the live runner).
		await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);
		expect(mockWarm.close).not.toHaveBeenCalled();
	});

	it("reaps all warm instances on shutdown (no orphans survive process exit)", async () => {
		injectSession({
			id: "sess-a",
			claudeSessionId: "a-id",
			updatedAt: 5,
			status: AgentSessionStatus.Active,
			workspace: { path: "/test/workspaces-a/ENG-6" },
			issueContext: { issueIdentifier: "ENG-6" },
		});
		injectSession({
			id: "sess-b",
			claudeSessionId: "b-id",
			updatedAt: 4,
			status: AgentSessionStatus.Active,
			workspace: { path: "/test/workspaces-a/ENG-7" },
			issueContext: { issueIdentifier: "ENG-7" },
		});

		await (edgeWorker as any).warmupRecentSessions();
		expect((edgeWorker as any).warmInstances.size).toBe(2);

		// Simulate the shutdown path reaping warm instances.
		(edgeWorker as any).reapAllWarmInstances();

		expect(mockWarm.close).toHaveBeenCalledTimes(2);
		expect((edgeWorker as any).warmInstances.size).toBe(0);
		expect((edgeWorker as any).warmInstanceExpiryTimers.size).toBe(0);
	});

	it("reaps a warm instance when its session reaches terminal state via issue terminal cleanup", async () => {
		injectSession({
			id: "sess-terminal",
			claudeSessionId: "terminal-id",
			updatedAt: 5,
			status: AgentSessionStatus.Active,
			workspace: { path: "/test/workspaces-a/ENG-8" },
			issueContext: { issueIdentifier: "ENG-8" },
		});

		await (edgeWorker as any).warmupRecentSessions();
		expect((edgeWorker as any).warmInstances.size).toBe(1);

		// The terminal-state handler calls reapWarmInstance for each session.
		(edgeWorker as any).reapWarmInstance("sess-terminal");

		expect(mockWarm.close).toHaveBeenCalledTimes(1);
		expect((edgeWorker as any).warmInstances.size).toBe(0);
	});
});
