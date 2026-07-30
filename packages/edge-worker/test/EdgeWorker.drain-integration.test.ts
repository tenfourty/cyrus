/**
 * EdgeWorker — drain integration tests
 *
 * Covers:
 * 1. getDrainController() returns a non-null DrainController.
 * 5. EdgeWorker.stop({kind: "force-killed"}) writes lastInFlightToolUses before persisting.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrainController } from "../src/DrainController.js";
import type { DrainOutcome } from "../src/drainTypes.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";

// ── global mocks ────────────────────────────────────────────────────────────

vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	mkdir: vi.fn(),
	rename: vi.fn(),
	readdir: vi.fn().mockResolvedValue([]),
}));

vi.mock("cyrus-claude-runner");
vi.mock("cyrus-codex-runner");
vi.mock("cyrus-gemini-runner");
vi.mock("cyrus-linear-event-transport");
vi.mock("@linear/sdk");

let mockPostFn: ReturnType<typeof vi.fn>;
let mockGetFn: ReturnType<typeof vi.fn>;

vi.mock("../src/SharedApplicationServer.js", () => ({
	SharedApplicationServer: vi.fn().mockImplementation(function () {
		return {
			initializeFastify: vi.fn(),
			getFastifyInstance: vi.fn(() => ({
				get: mockGetFn,
				post: mockPostFn,
			})),
			start: vi.fn().mockResolvedValue(undefined),
			stop: vi.fn().mockResolvedValue(undefined),
			getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
		};
	}),
}));

let mockSessionMap: Map<string, any>;

vi.mock("../src/AgentSessionManager.js", () => ({
	AgentSessionManager: vi.fn().mockImplementation(function () {
		mockSessionMap = new Map();
		return {
			getAllAgentRunners: vi.fn().mockReturnValue([]),
			getAllSessions: vi.fn().mockReturnValue([]),
			getActiveSessions: vi.fn().mockReturnValue([]),
			createCyrusAgentSession: vi.fn(),
			getSession: vi.fn((id: string) => mockSessionMap.get(id)),
			getActiveSessionsByIssueId: vi.fn().mockReturnValue([]),
			setActivitySink: vi.fn(),
			getActiveAttachedSessionIds: vi.fn().mockReturnValue([]),
			getPendingToolUseDetails: vi.fn().mockReturnValue([]),
			on: vi.fn(),
			off: vi.fn(),
			emit: vi.fn(),
			serializeState: vi.fn().mockReturnValue({ sessions: {}, entries: {} }),
		};
	}),
}));

vi.mock("cyrus-core", async (importOriginal) => {
	const actual = (await importOriginal()) as any;
	return {
		...actual,
		isAgentSessionCreatedWebhook: vi.fn().mockReturnValue(false),
		isAgentSessionPromptedWebhook: vi.fn().mockReturnValue(false),
		isIssueAssignedWebhook: vi.fn().mockReturnValue(false),
		isIssueCommentMentionWebhook: vi.fn().mockReturnValue(false),
		isIssueNewCommentWebhook: vi.fn().mockReturnValue(false),
		isIssueUnassignedWebhook: vi.fn().mockReturnValue(false),
		PersistenceManager: vi.fn().mockImplementation(function () {
			return {
				loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
				saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
			};
		}),
		requireLinearWorkspaceId: vi.fn().mockReturnValue("test-workspace"),
	};
});

vi.mock("file-type");
vi.mock("chokidar", () => ({
	watch: vi.fn().mockReturnValue({
		on: vi.fn().mockReturnThis(),
		close: vi.fn().mockResolvedValue(undefined),
	}),
}));

// ── test setup ────────────────────────────────────────────────────────────────

const mockRepository: RepositoryConfig = {
	id: "test-repo",
	name: "Test Repo",
	repositoryPath: "/test/repo",
	workspaceBaseDir: "/test/workspaces",
	baseBranch: "main",
	linearWorkspaceId: "test-workspace",
	isActive: true,
};

const baseConfig: EdgeWorkerConfig = {
	platform: "linear",
	cyrusHome: "/test/.cyrus",
	repositories: [mockRepository],
	linearWorkspaces: {
		"test-workspace": { linearToken: "test-token" },
	},
};

describe("EdgeWorker — drain integration", () => {
	let edgeWorker: EdgeWorker;

	beforeEach(() => {
		vi.clearAllMocks();
		mockPostFn = vi.fn();
		mockGetFn = vi.fn();

		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(async () => {
		if (edgeWorker) {
			try {
				await edgeWorker.stop();
			} catch {
				// ignore
			}
		}
	});

	// ── test 1 ───────────────────────────────────────────────────────────────

	it("getDrainController() returns a non-null DrainController instance", () => {
		edgeWorker = new EdgeWorker(baseConfig);
		const dc = (edgeWorker as any).getDrainController();
		expect(dc).toBeDefined();
		expect(dc).toBeInstanceOf(DrainController);
	});

	// ── test 2 ───────────────────────────────────────────────────────────────

	it("stop() with force-killed outcome writes lastInFlightToolUses before persisting", async () => {
		edgeWorker = new EdgeWorker(baseConfig);

		// Add a fake session to the session map
		const session = {
			id: "s1",
			workspace: { path: "/tmp/s1", isGitWorktree: false },
			repositories: [],
			status: "active" as any,
			type: "comment-thread" as any,
			context: "comment-thread" as any,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		mockSessionMap.set("s1", session);
		(edgeWorker as any).agentSessionManager.getSession.mockImplementation(
			(id: string) => mockSessionMap.get(id),
		);

		// Patch savePersistedState to capture state at save time
		let capturedSession: any = null;
		vi.spyOn(edgeWorker as any, "savePersistedState").mockImplementation(
			async () => {
				capturedSession = { ...mockSessionMap.get("s1") };
			},
		);

		const forceKillOutcome: DrainOutcome = {
			kind: "force-killed",
			durationMs: 1000,
			forcedSessions: [
				{
					sessionId: "s1",
					pendingToolUses: [
						{ id: "tool1", name: "Bash", startedAt: Date.now() - 5000 },
						{
							id: "tool2",
							name: "mcp__linear__save_comment",
							startedAt: Date.now() - 3000,
						},
					],
				},
			],
		};

		await edgeWorker.stop(forceKillOutcome);

		// Marker should have been written before persist
		expect(capturedSession.lastInFlightToolUses).toBeDefined();
		expect(capturedSession.lastInFlightToolUses).toHaveLength(2);
		expect(capturedSession.lastInFlightToolUses[0].name).toBe("Bash");
		expect(capturedSession.lastInFlightToolUses[1].name).toBe(
			"mcp__linear__save_comment",
		);
		expect(capturedSession.lastInFlightToolUses[0].killedAt).toMatch(
			/^\d{4}-\d{2}-\d{2}T/,
		);
	});
});

// ── helpers ────────────────────────────────────────────────────────────────────

function makeReply() {
	const r: any = {
		status: vi.fn().mockReturnThis(),
		send: vi.fn().mockReturnThis(),
		header: vi.fn().mockReturnThis(),
	};
	return r;
}
