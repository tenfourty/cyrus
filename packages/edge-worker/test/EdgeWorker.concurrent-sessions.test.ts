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
			// Stub the heavy create path; record the session as active AND give it
			// a live (running) runner, so the next trigger for the same issue
			// observes a genuinely live session — not just an Active-status one
			// (see isSessionLive in the guard).
			(edgeWorker as any).initializeAgentRunner = vi.fn(
				async (agentSession: any) => {
					const issueId = agentSession.issue.id;
					const list = activeByIssue.get(issueId) ?? [];
					list.push({ id: agentSession.id, updatedAt: ++clock });
					activeByIssue.set(issueId, list);
					runnersBySession.set(agentSession.id, { isRunning: () => true });
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

		it("initializes exactly one runner when two webhooks for the same issue race concurrently", async () => {
			// Slow, gated initializeAgentRunner: the first call's worktree/runner
			// creation stays pending (activeByIssue is NOT updated) until we
			// release the gate below. If the second, near-simultaneous webhook's
			// decision relied only on getActiveSessionsByIssueId (the pre-reservation
			// check), it would still see no active session for this issue and
			// start its own runner too. Only the per-issue lock + issuesInitializing
			// reservation (set synchronously before initializeAgentRunner is ever
			// awaited) can stop that second runner from starting.
			let releaseGate!: () => void;
			const gate = new Promise<void>((resolve) => {
				releaseGate = resolve;
			});
			let initCallCount = 0;
			(edgeWorker as any).initializeAgentRunner = vi.fn(
				async (agentSession: any) => {
					initCallCount++;
					await gate;
					const issueId = agentSession.issue.id;
					const list = activeByIssue.get(issueId) ?? [];
					list.push({ id: agentSession.id, updatedAt: ++clock });
					activeByIssue.set(issueId, list);
				},
			);

			const first = (edgeWorker as any).handleAgentSessionCreatedWebhook(
				createdWebhook(
					"sess-delegation",
					"This thread is for an agent session",
				),
				[mockRepository],
			);
			const second = (edgeWorker as any).handleAgentSessionCreatedWebhook(
				createdWebhook("sess-mention", "@cyrus also handle the edge case"),
				[mockRepository],
			);

			releaseGate();
			await Promise.all([first, second]);

			expect(initCallCount).toBe(1);
			expect((edgeWorker as any).initializeAgentRunner).toHaveBeenCalledTimes(
				1,
			);
			expect(
				(edgeWorker as any).foldDuplicateSessionIntoActive,
			).toHaveBeenCalledTimes(1);
		});

		it("releases the issuesInitializing reservation via `finally` when initializeAgentRunner throws", async () => {
			(edgeWorker as any).initializeAgentRunner = vi
				.fn()
				.mockRejectedValueOnce(new Error("boom"))
				.mockImplementation(async (agentSession: any) => {
					const issueId = agentSession.issue.id;
					const list = activeByIssue.get(issueId) ?? [];
					list.push({ id: agentSession.id, updatedAt: ++clock });
					activeByIssue.set(issueId, list);
				});

			await expect(
				(edgeWorker as any).handleAgentSessionCreatedWebhook(
					createdWebhook(
						"sess-delegation",
						"This thread is for an agent session",
					),
					[mockRepository],
				),
			).rejects.toThrow("boom");

			// The reservation must not be left dangling after the throw.
			expect((edgeWorker as any).issuesInitializing.has("issue-123")).toBe(
				false,
			);

			// A second trigger for the same issue must still be able to create a
			// runner (not be permanently folded in because of a stuck reservation).
			await (edgeWorker as any).handleAgentSessionCreatedWebhook(
				createdWebhook("sess-retry", "@cyrus retry"),
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
		beforeEach(() => {
			// A live fold-in target always has a resolvable repository in
			// production (initializeAgentRunner sets sessionRepositories before
			// the session can ever become live); mirror that here.
			(edgeWorker as any).sessionRepositories.set(
				"sess-live",
				mockRepository.id,
			);
		});

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
			// The note must only claim delivery when the comment was actually
			// fed into the target session (streamed here).
			expect(declineCall![0].content.body).toContain(
				"routed into that session",
			);
		});

		it("falls through to resuming the session when it can't accept a streamed message, and the note reflects real delivery", async () => {
			// isRunning: false → handlePromptWithStreamingCheck can't stream, so
			// it must fall through to resumeAgentSession rather than dropping the
			// comment or merely posting a timeline-only thought.
			const runner = {
				isRunning: vi.fn(() => false),
				supportsStreamingInput: true,
				addStreamMessage: vi.fn(),
			};
			runnersBySession.set("sess-live", runner);
			const resumeAgentSession = vi.fn().mockResolvedValue(undefined);
			(edgeWorker as any).resumeAgentSession = resumeAgentSession;

			await (edgeWorker as any).foldDuplicateSessionIntoActive(
				createdWebhook("sess-dup", "@cyrus extra context").agentSession,
				"sess-live",
				"test-workspace",
				"@cyrus extra context",
			);

			expect(runner.addStreamMessage).not.toHaveBeenCalled();
			expect(resumeAgentSession).toHaveBeenCalledWith(
				expect.objectContaining({ id: "sess-live" }),
				expect.objectContaining({ id: mockRepository.id }),
				"sess-live",
				expect.anything(),
				"@cyrus extra context",
				"",
				false,
				[],
				"test-workspace",
				undefined,
				undefined,
				undefined,
			);

			// No timeline-only fallback thought — the comment was actually
			// delivered via resume, so nothing was dropped.
			const thoughtCall = createAgentActivity.mock.calls.find(
				([input]) => input?.content?.type === "thought",
			);
			expect(thoughtCall).toBeUndefined();

			const declineCall = createAgentActivity.mock.calls.find(
				([input]) =>
					input?.agentSessionId === "sess-dup" &&
					input?.content?.type === "response",
			);
			expect(declineCall).toBeDefined();
			expect(declineCall![0].content.body).toContain(
				"routed into that session",
			);
		});

		it("falls back to a timeline-only thought (and an honest note) when the target session/repository can't be resolved", async () => {
			// No sessionRepositories mapping for "sess-unresolvable" and no
			// session registered in the AgentSessionManager mock — simulates a
			// target we can't actually deliver into.
			await (edgeWorker as any).foldDuplicateSessionIntoActive(
				createdWebhook("sess-dup", "@cyrus extra context").agentSession,
				"sess-unresolvable",
				"test-workspace",
				"@cyrus extra context",
			);

			const thoughtCall = createAgentActivity.mock.calls.find(
				([input]) =>
					input?.agentSessionId === "sess-unresolvable" &&
					input?.content?.type === "thought" &&
					String(input?.content?.body).includes("@cyrus extra context"),
			);
			expect(thoughtCall).toBeDefined();

			// The note must NOT claim the message was routed into the session —
			// only a thought was posted, which does not feed the runner.
			const declineCall = createAgentActivity.mock.calls.find(
				([input]) =>
					input?.agentSessionId === "sess-dup" &&
					input?.content?.type === "response",
			);
			expect(declineCall).toBeDefined();
			expect(declineCall![0].content.body).not.toContain(
				"routed into that session",
			);
			expect(declineCall![0].content.body).toContain(
				"posted to that session's thread",
			);
		});

		it("echoes the comment into the decline note when there is no live runner yet (initializing sibling)", async () => {
			await (edgeWorker as any).foldDuplicateSessionIntoActive(
				createdWebhook("sess-dup", "@cyrus also rename the flag").agentSession,
				undefined, // sibling still initializing — no target/runner
				"test-workspace",
				"@cyrus also rename the flag",
			);

			// The duplicate's message is preserved in its own closing response,
			// not silently dropped.
			const declineCall = createAgentActivity.mock.calls.find(
				([input]) =>
					input?.agentSessionId === "sess-dup" &&
					input?.content?.type === "response" &&
					String(input?.content?.body).includes("@cyrus also rename the flag"),
			);
			expect(declineCall).toBeDefined();
		});
	});
});
