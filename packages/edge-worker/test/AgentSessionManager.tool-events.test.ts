import type {
	SDKAssistantMessage,
	SDKResultMessage,
	SDKUserMessage,
} from "cyrus-claude-runner";
import { ClaudeMessageFormatter } from "cyrus-claude-runner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";

/**
 * Tests for tool_use lifecycle events emitted by AgentSessionManager:
 *   - tool_use_started  (on assistant message with tool_use block)
 *   - tool_use_completed (on user message with matching tool_result)
 *   - session_terminal   (on result message)
 *
 * Also covers query helpers:
 *   - getPendingToolUseIds(sessionId)
 *   - getPendingToolUseDetails(sessionId)
 *   - getActiveAttachedSessionIds()
 */
describe("AgentSessionManager - tool_use lifecycle events", () => {
	let manager: AgentSessionManager;
	let mockActivitySink: IActivitySink;
	const sessionId = "test-session-tool-events";
	const issueId = "issue-tool-events";

	function buildToolUse(
		id: string,
		name: string,
		input: Record<string, unknown> = {},
	): SDKAssistantMessage {
		return {
			type: "assistant",
			session_id: "claude-session",
			parent_tool_use_id: null,
			uuid: `uuid-${id}`,
			message: {
				id: "msg_1",
				type: "message",
				role: "assistant",
				model: "claude",
				stop_reason: "tool_use",
				stop_sequence: null,
				usage: {
					input_tokens: 0,
					output_tokens: 0,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
				},
				content: [
					{
						type: "tool_use",
						id,
						name,
						input,
					},
				],
			},
		} as unknown as SDKAssistantMessage;
	}

	function buildToolResult(toolUseId: string, isError = false): SDKUserMessage {
		return {
			type: "user",
			session_id: "claude-session",
			parent_tool_use_id: null,
			uuid: `uuid-result-${toolUseId}`,
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: toolUseId,
						is_error: isError,
						content: [{ type: "text", text: isError ? "Error" : "OK" }],
					},
				],
			},
		} as unknown as SDKUserMessage;
	}

	function buildResultMessage(): SDKResultMessage {
		return {
			type: "result",
			subtype: "success",
			duration_ms: 100,
			duration_api_ms: 0,
			is_error: false,
			num_turns: 1,
			result: "done",
			stop_reason: null,
			total_cost_usd: 0,
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				server_tool_use: { web_search_requests: 0 },
			},
			modelUsage: {},
			permission_denials: [],
			uuid: "result-uuid",
			session_id: "claude-session",
		} as unknown as SDKResultMessage;
	}

	beforeEach(() => {
		mockActivitySink = {
			id: "test-workspace",
			postActivity: vi.fn().mockResolvedValue({ activityId: "activity-1" }),
			createAgentSession: vi.fn().mockResolvedValue("ext-session-1"),
		};

		manager = new AgentSessionManager();
		manager.createCyrusAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "TEST-TOOL-1",
				title: "Tool events test",
				description: "",
				branchName: "test-branch",
			},
			{ path: "/tmp/workspace", isGitWorktree: false },
		);
		manager.setActivitySink(sessionId, mockActivitySink);

		// Minimal runner stub (needed for tool-use formatting path)
		const formatter = new ClaudeMessageFormatter();
		const runnerStub = {
			getFormatter: () => formatter,
			constructor: { name: "ClaudeRunner" },
		} as unknown as Parameters<typeof manager.addAgentRunner>[1];
		manager.addAgentRunner(sessionId, runnerStub);
	});

	it("emits tool_use_started when assistant message with tool_use block arrives", async () => {
		const events: unknown[] = [];
		manager.on("tool_use_started", (event) => events.push(event));

		await manager.handleClaudeMessage(
			sessionId,
			buildToolUse("toolu_1", "Bash", { command: "ls" }),
		);

		expect(events).toHaveLength(1);
		const event = events[0] as {
			sessionId: string;
			toolUse: { id: string; name: string; startedAt: number };
		};
		expect(event.sessionId).toBe(sessionId);
		expect(event.toolUse.id).toBe("toolu_1");
		expect(event.toolUse.name).toBe("Bash");
		expect(typeof event.toolUse.startedAt).toBe("number");
	});

	it("emits tool_use_completed when user message with matching tool_result arrives", async () => {
		const completedEvents: unknown[] = [];
		manager.on("tool_use_completed", (event) => completedEvents.push(event));

		await manager.handleClaudeMessage(
			sessionId,
			buildToolUse("toolu_2", "Read", { file_path: "/tmp/x" }),
		);
		await manager.handleClaudeMessage(
			sessionId,
			buildToolResult("toolu_2", false),
		);

		expect(completedEvents).toHaveLength(1);
		const event = completedEvents[0] as {
			sessionId: string;
			toolUseId: string;
			isError: boolean;
		};
		expect(event.sessionId).toBe(sessionId);
		expect(event.toolUseId).toBe("toolu_2");
		expect(event.isError).toBe(false);
	});

	it("emits tool_use_completed with isError=true for error results", async () => {
		const completedEvents: unknown[] = [];
		manager.on("tool_use_completed", (event) => completedEvents.push(event));

		await manager.handleClaudeMessage(
			sessionId,
			buildToolUse("toolu_err", "Bash", { command: "false" }),
		);
		await manager.handleClaudeMessage(
			sessionId,
			buildToolResult("toolu_err", true),
		);

		expect(completedEvents).toHaveLength(1);
		const event = completedEvents[0] as { isError: boolean };
		expect(event.isError).toBe(true);
	});

	it("emits session_terminal on result message", async () => {
		const terminalEvents: unknown[] = [];
		manager.on("session_terminal", (event) => terminalEvents.push(event));

		await manager.handleClaudeMessage(sessionId, buildResultMessage());

		// A result message intentionally fires session_terminal twice: the
		// pre-flip drain-tracking emit, then the post-flip persistence emit via
		// completeSession -> updateSessionStatus. This double-emit is documented
		// as safe (consumers are idempotent). Both carry the same sessionId.
		expect(terminalEvents).toHaveLength(2);
		for (const event of terminalEvents as { sessionId: string }[]) {
			expect(event.sessionId).toBe(sessionId);
		}
	});

	it("getPendingToolUseIds returns open set and clears on tool_result", async () => {
		// Initially empty
		expect(manager.getPendingToolUseIds(sessionId).size).toBe(0);

		await manager.handleClaudeMessage(
			sessionId,
			buildToolUse("toolu_3", "Write", {}),
		);
		expect(manager.getPendingToolUseIds(sessionId)).toEqual(
			new Set(["toolu_3"]),
		);

		await manager.handleClaudeMessage(sessionId, buildToolResult("toolu_3"));
		expect(manager.getPendingToolUseIds(sessionId).size).toBe(0);
	});

	it("getPendingToolUseDetails returns metadata for open tool uses", async () => {
		const before = Date.now();
		await manager.handleClaudeMessage(
			sessionId,
			buildToolUse("toolu_4", "Grep", { pattern: "foo" }),
		);
		const after = Date.now();

		const details = manager.getPendingToolUseDetails(sessionId);
		expect(details).toHaveLength(1);
		expect(details[0].id).toBe("toolu_4");
		expect(details[0].name).toBe("Grep");
		expect(details[0].startedAt).toBeGreaterThanOrEqual(before);
		expect(details[0].startedAt).toBeLessThanOrEqual(after);
	});

	it("getPendingToolUseDetails returns empty after tool_result", async () => {
		await manager.handleClaudeMessage(
			sessionId,
			buildToolUse("toolu_5", "Bash", {}),
		);
		await manager.handleClaudeMessage(sessionId, buildToolResult("toolu_5"));

		expect(manager.getPendingToolUseDetails(sessionId)).toHaveLength(0);
	});

	it("getActiveAttachedSessionIds returns sessions with an agent runner", () => {
		const ids = manager.getActiveAttachedSessionIds();
		expect(ids).toContain(sessionId);
	});

	it("getActiveAttachedSessionIds does not include sessions without a runner", () => {
		const otherSessionId = "session-no-runner";
		manager.createCyrusAgentSession(
			otherSessionId,
			"issue-no-runner",
			{
				id: "issue-no-runner",
				identifier: "TEST-NORUN",
				title: "No runner",
				description: "",
				branchName: "no-runner-branch",
			},
			{ path: "/tmp/workspace2", isGitWorktree: false },
		);
		// Note: no addAgentRunner call for otherSessionId

		const ids = manager.getActiveAttachedSessionIds();
		expect(ids).toContain(sessionId);
		expect(ids).not.toContain(otherSessionId);
	});

	it("duplicate tool_result for already-cleared id does NOT re-emit tool_use_completed (replay safety)", async () => {
		const completedEvents: unknown[] = [];
		manager.on("tool_use_completed", (event) => completedEvents.push(event));

		await manager.handleClaudeMessage(
			sessionId,
			buildToolUse("toolu_replay", "Bash", {}),
		);
		await manager.handleClaudeMessage(
			sessionId,
			buildToolResult("toolu_replay"),
		);
		// Second (duplicate) result for same tool_use_id
		await manager.handleClaudeMessage(
			sessionId,
			buildToolResult("toolu_replay"),
		);

		// Only one completed event should have fired
		expect(completedEvents).toHaveLength(1);
	});

	it("does NOT double-emit tool_use_started for duplicate tool_use id", async () => {
		const startedEvents: unknown[] = [];
		manager.on("tool_use_started", (event) => startedEvents.push(event));

		await manager.handleClaudeMessage(
			sessionId,
			buildToolUse("toolu_dup", "Bash", {}),
		);
		// Hypothetical duplicate (shouldn't happen in practice but must be safe)
		await manager.handleClaudeMessage(
			sessionId,
			buildToolUse("toolu_dup", "Bash", {}),
		);

		// Only one started event should have fired for the same ID
		expect(startedEvents).toHaveLength(1);
	});

	it("pending tool uses are cleaned up on session_terminal", async () => {
		await manager.handleClaudeMessage(
			sessionId,
			buildToolUse("toolu_orphan", "Bash", {}),
		);
		// Orphaned — no tool_result before result message
		expect(manager.getPendingToolUseIds(sessionId).size).toBe(1);

		await manager.handleClaudeMessage(sessionId, buildResultMessage());

		// After terminal, pending set should be cleared
		expect(manager.getPendingToolUseIds(sessionId).size).toBe(0);
	});

	it("clears pending tool-use tracking when removeSession is called", async () => {
		// arrange: emit a tool_use, do not emit tool_result, do not emit result
		await manager.handleClaudeMessage(
			sessionId,
			buildToolUse("toolu_remove", "Bash", {}),
		);
		expect(manager.getPendingToolUseIds(sessionId).size).toBe(1);

		// act: call removeSession
		manager.removeSession(sessionId);

		// assert: getPendingToolUseIds returns empty set for removed session
		expect(manager.getPendingToolUseIds(sessionId).size).toBe(0);
		expect(manager.getPendingToolUseDetails(sessionId)).toHaveLength(0);
	});

	it("clears pending tool-use tracking when cleanup() removes a session", async () => {
		// arrange: create a session that is in "complete" state and old enough to be cleaned up
		const oldSessionId = "old-session-cleanup";
		const issueId2 = "issue-cleanup";

		manager.createCyrusAgentSession(
			oldSessionId,
			issueId2,
			{
				id: issueId2,
				identifier: "TEST-CLEAN-1",
				title: "Cleanup test",
				description: "",
				branchName: "cleanup-branch",
			},
			{ path: "/tmp/workspace-cleanup", isGitWorktree: false },
		);
		manager.setActivitySink(oldSessionId, mockActivitySink);
		const formatter = new ClaudeMessageFormatter();
		const runnerStub = {
			getFormatter: () => formatter,
			constructor: { name: "ClaudeRunner" },
		} as unknown as Parameters<typeof manager.addAgentRunner>[1];
		manager.addAgentRunner(oldSessionId, runnerStub);

		// emit a tool_use that will be orphaned
		await manager.handleClaudeMessage(
			oldSessionId,
			buildToolUse("toolu_cleanup", "Bash", {}),
		);
		expect(manager.getPendingToolUseIds(oldSessionId).size).toBe(1);

		// manually mark session as complete and force it to be old (manipulate internal state for test)
		// by calling handleClaudeMessage with a result message
		await manager.handleClaudeMessage(oldSessionId, buildResultMessage());

		// Verify cleanup removes the session and its pending tool-use tracking
		manager.cleanup(0); // olderThanMs=0 means cleanup everything that's complete/error

		// assert: getPendingToolUseIds for the cleaned session returns empty set
		expect(manager.getPendingToolUseIds(oldSessionId).size).toBe(0);
		expect(manager.getPendingToolUseDetails(oldSessionId)).toHaveLength(0);
	});
});
