import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

// Preserve real cyrus-claude-runner exports; only stub the runner class.
vi.mock("cyrus-claude-runner", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	ClaudeRunner: vi.fn(),
}));
vi.mock("cyrus-codex-runner");
vi.mock("cyrus-cursor-runner");
vi.mock("cyrus-gemini-runner");
vi.mock("@linear/sdk");
vi.mock("cyrus-linear-event-transport");
vi.mock("../src/SharedApplicationServer.js");
vi.mock("../src/AgentSessionManager.js");
vi.mock("fs/promises", () => ({
	readFile: vi.fn().mockResolvedValue(""),
	writeFile: vi.fn(),
	mkdir: vi.fn(),
	rename: vi.fn(),
}));

import { LinearClient } from "@linear/sdk";
import type { LinearAgentSessionCreatedWebhook } from "cyrus-core";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";

const mockRepository: RepositoryConfig = {
	id: "test-repo",
	name: "Test Repo",
	repositoryPath: "/test/repo",
	workspaceBaseDir: "/test/workspaces",
	baseBranch: "main",
	linearWorkspaceId: "test-workspace",
	isActive: true,
	allowedTools: ["Read", "Edit"],
};

function createdWebhook(
	sessionId: string,
	commentBody: string,
	issueId = "issue-123",
	identifier = "TEST-123",
): LinearAgentSessionCreatedWebhook {
	return {
		type: "Issue",
		action: "agentSessionCreated",
		organizationId: "test-workspace",
		agentSession: {
			id: sessionId,
			issue: { id: issueId, identifier, team: { key: "TEST" } },
			comment: { body: commentBody },
		},
	} as unknown as LinearAgentSessionCreatedWebhook;
}

// Auto-stubbing AgentSessionManager mock: seed the methods this path needs,
// auto-stub everything else so new methods never break the test.
function makeSessionManager(seed: Record<string, any>) {
	return new Proxy(seed, {
		get(obj, prop, receiver) {
			if (typeof prop === "symbol" || prop in obj) {
				return Reflect.get(obj, prop, receiver);
			}
			obj[prop as string] = vi.fn();
			return obj[prop as string];
		},
	});
}

describe("EdgeWorker - concurrent sessions on one issue", () => {
	let edgeWorker: EdgeWorker;
	let mockConfig: EdgeWorkerConfig;
	let activeByIssue: Map<string, any[]>;
	let runnersBySession: Map<string, any>;
	let createAgentActivity: ReturnType<typeof vi.fn>;
	let clock: number;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		activeByIssue = new Map();
		runnersBySession = new Map();
		clock = 0;

		vi.mocked(LinearClient).mockImplementation(function () {
			return {
				viewer: vi.fn().mockResolvedValue({ id: "u", email: "u@x.com" }),
			};
		} as any);

		vi.mocked(AgentSessionManager).mockImplementation(function () {
			return makeSessionManager({
				getActiveSessionsByIssueId: vi.fn(
					(issueId: string) => activeByIssue.get(issueId) ?? [],
				),
				getActiveSessions: vi.fn(() => []),
				getSession: vi.fn((id: string) => ({
					id,
					agentRunner: runnersBySession.get(id),
				})),
				getAllAgentRunners: vi.fn(() => []),
				serializeState: vi.fn(() => ({ sessions: {}, entries: {} })),
			});
		} as any);

		vi.mocked(LinearEventTransport).mockImplementation(function () {
			return { register: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };
		} as any);

		vi.mocked(SharedApplicationServer).mockImplementation(function () {
			return {
				start: vi.fn().mockResolvedValue(undefined),
				stop: vi.fn().mockResolvedValue(undefined),
				getFastifyInstance: vi.fn().mockReturnValue({ post: vi.fn() }),
				getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
				registerOAuthCallbackHandler: vi.fn(),
			};
		} as any);

		mockConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [mockRepository],
			linearWorkspaces: { "test-workspace": { linearToken: "test-token" } },
			handlers: {
				createWorkspace: vi.fn().mockResolvedValue({
					path: "/test/workspaces/TEST-123",
					isGitWorktree: false,
				}),
			},
		};

		edgeWorker = new EdgeWorker(mockConfig);

		createAgentActivity = vi.fn().mockResolvedValue({ success: true });
		(edgeWorker as any).issueTrackers.set(mockRepository.linearWorkspaceId, {
			fetchIssue: vi.fn().mockResolvedValue({
				id: "issue-123",
				identifier: "TEST-123",
				labels: vi.fn().mockResolvedValue({ nodes: [] }),
			}),
			getIssueLabels: vi.fn().mockResolvedValue([]),
			getClient: vi.fn().mockReturnValue({}),
			createAgentActivity,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("dispatch: create vs fold-in", () => {
		beforeEach(() => {
			// Stub the heavy create path; record the session as active so the next
			// trigger for the same issue observes a live session.
			(edgeWorker as any).initializeAgentRunner = vi.fn(
				async (agentSession: any) => {
					const issueId = agentSession.issue.id;
					const list = activeByIssue.get(issueId) ?? [];
					list.push({ id: agentSession.id, updatedAt: ++clock });
					activeByIssue.set(issueId, list);
				},
			);
			(edgeWorker as any).foldDuplicateSessionIntoActive = vi.fn();
		});

		it("starts a runner for the first trigger and folds the second into it", async () => {
			await (edgeWorker as any).handleAgentSessionCreatedWebhook(
				createdWebhook(
					"sess-delegation",
					"This thread is for an agent session",
				),
				[mockRepository],
			);
			expect((edgeWorker as any).initializeAgentRunner).toHaveBeenCalledTimes(
				1,
			);
			expect(
				(edgeWorker as any).foldDuplicateSessionIntoActive,
			).not.toHaveBeenCalled();

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(
				createdWebhook("sess-mention", "@cyrus also handle the edge case"),
				[mockRepository],
			);

			// No second runner; the duplicate is folded into the live session.
			expect((edgeWorker as any).initializeAgentRunner).toHaveBeenCalledTimes(
				1,
			);
			const fold = (edgeWorker as any).foldDuplicateSessionIntoActive;
			expect(fold).toHaveBeenCalledTimes(1);
			expect(fold.mock.calls[0][0].id).toBe("sess-mention"); // duplicate session
			expect(fold.mock.calls[0][1]).toBe("sess-delegation"); // fold target
		});

		it("starts independent runners for different issues (no false dedup)", async () => {
			await (edgeWorker as any).handleAgentSessionCreatedWebhook(
				createdWebhook("sess-a", "This thread is for an agent session"),
				[mockRepository],
			);
			await (edgeWorker as any).handleAgentSessionCreatedWebhook(
				createdWebhook("sess-b", "@cyrus do this", "issue-999", "TEST-999"),
				[mockRepository],
			);
			expect((edgeWorker as any).initializeAgentRunner).toHaveBeenCalledTimes(
				2,
			);
			expect(
				(edgeWorker as any).foldDuplicateSessionIntoActive,
			).not.toHaveBeenCalled();
		});
	});

	describe("foldDuplicateSessionIntoActive", () => {
		it("routes the comment into the live runner and closes the duplicate thread", async () => {
			const runner = {
				isRunning: vi.fn(() => true),
				supportsStreamingInput: true,
				addStreamMessage: vi.fn(),
			};
			runnersBySession.set("sess-live", runner);

			await (edgeWorker as any).foldDuplicateSessionIntoActive(
				createdWebhook("sess-dup", "@cyrus extra context").agentSession,
				"sess-live",
				"test-workspace",
				"@cyrus extra context",
			);

			expect(runner.addStreamMessage).toHaveBeenCalledWith(
				"@cyrus extra context",
			);
			const declineCall = createAgentActivity.mock.calls.find(
				([input]) =>
					input?.agentSessionId === "sess-dup" &&
					input?.content?.type === "response",
			);
			expect(declineCall).toBeDefined();
		});

		it("falls back to a thought when the live runner can't accept a streamed message", async () => {
			const runner = {
				isRunning: vi.fn(() => false), // not running → can't stream
				supportsStreamingInput: true,
				addStreamMessage: vi.fn(),
			};
			runnersBySession.set("sess-live", runner);

			await (edgeWorker as any).foldDuplicateSessionIntoActive(
				createdWebhook("sess-dup", "@cyrus extra context").agentSession,
				"sess-live",
				"test-workspace",
				"@cyrus extra context",
			);

			expect(runner.addStreamMessage).not.toHaveBeenCalled();
			const thoughtCall = createAgentActivity.mock.calls.find(
				([input]) =>
					input?.agentSessionId === "sess-live" &&
					input?.content?.type === "thought" &&
					String(input?.content?.body).includes("@cyrus extra context"),
			);
			expect(thoughtCall).toBeDefined();
		});
	});
});
