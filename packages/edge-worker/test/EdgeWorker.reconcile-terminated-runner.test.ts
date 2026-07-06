import { LinearClient } from "@linear/sdk";
import { ClaudeRunner } from "cyrus-claude-runner";
import { AgentSessionStatus } from "cyrus-core";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";
import { createMockAgentSessionManager } from "./edgeWorkerMocks.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

// Mock all dependencies — same set as other EdgeWorker unit tests
// (e.g. EdgeWorker.system-prompt-resume.test.ts), since AgentSessionManager
// itself is a fully-mocked collaborator here: this suite verifies the
// EdgeWorker -> AgentSessionManager wiring (which calls happen, with what
// args, under what gating), not AgentSessionManager's own status-flip
// behavior (covered by AgentSessionManager.stop-session.test.ts against a
// real instance).
vi.mock("cyrus-claude-runner");
vi.mock("cyrus-codex-runner");
vi.mock("cyrus-linear-event-transport");
vi.mock("@linear/sdk");
vi.mock("../src/SharedApplicationServer.js");
vi.mock("../src/AgentSessionManager.js");
vi.mock("cyrus-core", async (importOriginal) => {
	const actual = (await importOriginal()) as any;
	return {
		...actual,
		PersistenceManager: vi.fn().mockImplementation(function () {
			return {
				loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
				saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
			};
		}),
	};
});

describe("EdgeWorker - reconcileTerminatedRunner", () => {
	let edgeWorker: EdgeWorker;
	let mockAgentSessionManager: any;

	const mockRepository: RepositoryConfig = {
		id: "test-repo",
		name: "Test Repo",
		repositoryPath: "/test/repo",
		workspaceBaseDir: "/test/workspaces",
		baseBranch: "main",
		linearWorkspaceId: "test-workspace",
		isActive: true,
		allowedTools: ["Read", "Edit"],
		labelPrompts: {},
	};

	function makeSession(overrides: Record<string, unknown> = {}) {
		return {
			id: "session-1",
			externalSessionId: "external-session-1",
			status: AgentSessionStatus.Active,
			issueContext: {
				trackerId: "linear",
				issueId: "issue-1",
				issueIdentifier: "TEST-1",
			},
			...overrides,
		};
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		vi.mocked(ClaudeRunner).mockImplementation(function () {
			return {
				supportsStreamingInput: true,
				startStreaming: vi
					.fn()
					.mockResolvedValue({ sessionId: "claude-session-1" }),
				stop: vi.fn(),
				isStreaming: vi.fn().mockReturnValue(false),
			};
		} as any);

		// Shared factory auto-stubs every method, so new AgentSessionManager
		// methods never break this test; getSession is overridden per-scenario.
		mockAgentSessionManager = createMockAgentSessionManager({
			getSession: vi.fn().mockReturnValue(makeSession()),
		});
		vi.mocked(AgentSessionManager).mockImplementation(function () {
			return mockAgentSessionManager;
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

		vi.mocked(LinearEventTransport).mockImplementation(function () {
			return {
				register: vi.fn(),
				on: vi.fn(),
				removeAllListeners: vi.fn(),
			};
		} as any);

		vi.mocked(LinearClient).mockImplementation(function () {
			return {
				users: {
					me: vi.fn().mockResolvedValue({ id: "user-1", name: "Test User" }),
				},
			};
		} as any);

		const mockConfig: EdgeWorkerConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [mockRepository],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
			handlers: {
				createWorkspace: vi.fn().mockResolvedValue({
					path: "/test/workspaces/TEST-1",
					isGitWorktree: false,
				}),
			},
		};

		edgeWorker = new EdgeWorker(mockConfig);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("posts a visible notice and reconciles to Error when a Linear session dies out of band", async () => {
		mockAgentSessionManager.getSession.mockReturnValue(makeSession());

		await (edgeWorker as any).reconcileTerminatedRunner("session-1", {
			reason: "error",
		});

		expect(mockAgentSessionManager.createErrorActivity).toHaveBeenCalledOnce();
		const [sessionId, body] =
			mockAgentSessionManager.createErrorActivity.mock.calls[0];
		expect(sessionId).toBe("session-1");
		expect(body).toMatch(/stopped unexpectedly/);
		expect(body).toContain("reason: error");
		// Coarse reason only — never raw error text/stack.
		expect(body).not.toMatch(/stack|Gateway|ECONNRESET/i);

		expect(mockAgentSessionManager.markSessionStopped).toHaveBeenCalledWith(
			"session-1",
		);
		// The notice must be posted before the status flip so preStatus reads
		// as non-terminal.
		const createOrder =
			mockAgentSessionManager.createErrorActivity.mock.invocationCallOrder[0];
		const stopOrder =
			mockAgentSessionManager.markSessionStopped.mock.invocationCallOrder[0];
		expect(createOrder).toBeLessThan(stopOrder);
	});

	it("does NOT post when the pre-flip status is already terminal", async () => {
		mockAgentSessionManager.getSession.mockReturnValue(
			makeSession({ status: AgentSessionStatus.Error }),
		);

		await (edgeWorker as any).reconcileTerminatedRunner("session-1", {
			reason: "sigterm",
		});

		expect(mockAgentSessionManager.createErrorActivity).not.toHaveBeenCalled();
		expect(mockAgentSessionManager.markSessionStopped).toHaveBeenCalledWith(
			"session-1",
		);
	});

	it("does NOT post for a non-Linear tracker", async () => {
		mockAgentSessionManager.getSession.mockReturnValue(
			makeSession({
				issueContext: {
					trackerId: "gitlab",
					issueId: "issue-1",
					issueIdentifier: "TEST-1",
				},
			}),
		);

		await (edgeWorker as any).reconcileTerminatedRunner("session-1", {
			reason: "abort",
		});

		expect(mockAgentSessionManager.createErrorActivity).not.toHaveBeenCalled();
		expect(mockAgentSessionManager.markSessionStopped).toHaveBeenCalledWith(
			"session-1",
		);
	});

	it("no-ops for an unknown session (no notice, no stop)", async () => {
		mockAgentSessionManager.getSession.mockReturnValue(undefined);

		await (edgeWorker as any).reconcileTerminatedRunner("unknown-session", {
			reason: "error",
		});

		expect(mockAgentSessionManager.createErrorActivity).not.toHaveBeenCalled();
		expect(mockAgentSessionManager.markSessionStopped).not.toHaveBeenCalled();
	});

	it("posts again after a re-ping resets status back to Active (self-resetting, no sticky flag)", async () => {
		// First out-of-band termination: Active -> notice posted.
		mockAgentSessionManager.getSession.mockReturnValue(makeSession());
		await (edgeWorker as any).reconcileTerminatedRunner("session-1", {
			reason: "error",
		});
		expect(mockAgentSessionManager.createErrorActivity).toHaveBeenCalledOnce();

		// Re-prompt resumes the session: markSessionResuming would flip status
		// back to Active. Simulate that by returning Active again.
		mockAgentSessionManager.getSession.mockReturnValue(makeSession());
		await (edgeWorker as any).reconcileTerminatedRunner("session-1", {
			reason: "error",
		});

		expect(mockAgentSessionManager.createErrorActivity).toHaveBeenCalledTimes(
			2,
		);
	});
});
