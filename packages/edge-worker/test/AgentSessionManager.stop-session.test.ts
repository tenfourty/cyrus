import { AgentSessionStatus } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";

describe("AgentSessionManager stop-session behavior", () => {
	let manager: AgentSessionManager;
	let mockActivitySink: IActivitySink;
	let postActivitySpy: any;
	const sessionId = "test-session-stop";
	const issueId = "issue-stop";

	beforeEach(() => {
		mockActivitySink = {
			id: "test-workspace",
			postActivity: vi.fn().mockResolvedValue({ activityId: "activity-1" }),
			createAgentSession: vi.fn().mockResolvedValue("session-1"),
		};

		postActivitySpy = vi.spyOn(mockActivitySink, "postActivity");

		manager = new AgentSessionManager();

		manager.createCyrusAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "TEST-STOP",
				title: "Stop Session Test",
				description: "test",
				branchName: "test-stop",
			},
			{
				path: "/tmp/workspace",
				isGitWorktree: false,
			},
		);
		manager.setActivitySink(sessionId, mockActivitySink);
	});

	it("marks session as error when a session stop is requested", async () => {
		manager.requestSessionStop(sessionId);

		await manager.completeSession(sessionId, {
			type: "result",
			subtype: "success",
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: false,
			num_turns: 1,
			result: "Stopped run should not continue",
			stop_reason: null,
			total_cost_usd: 0,
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation: null,
			},
			modelUsage: {},
			permission_denials: [],
			uuid: "result-1",
			session_id: "sdk-session",
		} as any);

		expect(manager.getSession(sessionId)?.status).toBe(
			AgentSessionStatus.Error,
		);
	});

	it("exposes consumeStopRequest publicly so the prompt handler can clear stale stop flags", () => {
		// Background: requestSessionStop sets a flag that, prior to this change,
		// was consumed ONLY by completeSession (on result arrival) or by
		// removeSession (on issue-terminal cleanup). A user-initiated stop with
		// no subsequent terminal cleanup left the flag set forever, and every
		// future prompt to the same session aborted at shouldAbortSpawn.
		// Exposing consumeStopRequest lets the new-prompt entry path clear the
		// flag so the user's next prompt actually runs.
		manager.requestSessionStop(sessionId);
		expect(manager.isStopRequested(sessionId)).toBe(true);

		const wasCleared = manager.consumeStopRequest(sessionId);
		expect(wasCleared).toBe(true);
		expect(manager.isStopRequested(sessionId)).toBe(false);

		const secondCall = manager.consumeStopRequest(sessionId);
		expect(secondCall).toBe(false);
	});

	it("handles non max-turn execution errors gracefully", async () => {
		await manager.completeSession(sessionId, {
			type: "result",
			subtype: "error_during_execution",
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: true,
			num_turns: 1,
			errors: ["aborted by user"],
			stop_reason: null,
			total_cost_usd: 0,
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation: null,
			},
			modelUsage: {},
			permission_denials: [],
			uuid: "result-2",
			session_id: "sdk-session",
		} as any);

		// Session should be marked as error for execution errors
		expect(manager.getSession(sessionId)?.status).toBe(
			AgentSessionStatus.Error,
		);
	});

	describe("markSessionStopped (status-on-stop without runner result)", () => {
		it("flips session.status to Error", async () => {
			manager.requestSessionStop(sessionId);

			await manager.markSessionStopped(sessionId);

			expect(manager.getSession(sessionId)?.status).toBe(
				AgentSessionStatus.Error,
			);
		});

		it("does not consume the stop flag — a late runner result still hits the wasStopRequested branch", async () => {
			manager.requestSessionStop(sessionId);

			await manager.markSessionStopped(sessionId);

			// Simulate a late "success" result message arriving after the
			// runner was force-killed. If markSessionStopped consumed the
			// stop flag, completeSession's `wasStopRequested` would be
			// false and a success subtype would mis-flip status to Complete,
			// losing the stop record. The flag must remain set so the
			// late-emit path still treats the session as stopped.
			await manager.completeSession(sessionId, {
				type: "result",
				subtype: "success",
				duration_ms: 1,
				duration_api_ms: 1,
				is_error: false,
				num_turns: 1,
				result: "late success after kill",
				stop_reason: null,
				total_cost_usd: 0,
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation: null,
				},
				modelUsage: {},
				permission_denials: [],
				uuid: "late-result",
				session_id: "sdk-session",
			} as any);

			expect(manager.getSession(sessionId)?.status).toBe(
				AgentSessionStatus.Error,
			);
		});

		it("is a no-op when the session no longer exists", async () => {
			await expect(
				manager.markSessionStopped("never-existed"),
			).resolves.toBeUndefined();
		});

		it("flips status to Error even when no stop flag was ever set (defensive)", async () => {
			await manager.markSessionStopped(sessionId);
			expect(manager.getSession(sessionId)?.status).toBe(
				AgentSessionStatus.Error,
			);
		});
	});

	describe("markSessionStale (status-on-stall without runner result)", () => {
		it("flips session.status to Stale", async () => {
			await manager.markSessionStale(sessionId);

			expect(manager.getSession(sessionId)?.status).toBe(
				AgentSessionStatus.Stale,
			);
		});

		it("is a no-op when the session no longer exists", async () => {
			await expect(
				manager.markSessionStale("never-existed"),
			).resolves.toBeUndefined();
		});

		it("clears a captured assistant error (A2 consistency): a stale watchdog kill mid-turn must not leak a truncation note into the next clean turn", async () => {
			// Simulate a captured max_output_tokens error mid-turn (see
			// AgentSessionManager.truncation.test.ts), then the stall watchdog
			// aborts before a result message ever arrives for that turn.
			await manager.handleClaudeMessage(sessionId, {
				type: "assistant",
				session_id: "sdk-session",
				parent_tool_use_id: null,
				uuid: "uuid-assistant-stale",
				error: "max_output_tokens",
				message: {
					id: "msg_1",
					type: "message",
					role: "assistant",
					model: "claude",
					stop_reason: null,
					stop_sequence: null,
					usage: {
						input_tokens: 0,
						output_tokens: 0,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 0,
					},
					content: [{ type: "text", text: "partial turn, then stall" }],
				},
			} as any);

			await manager.markSessionStale(sessionId);

			postActivitySpy.mockClear();

			// A subsequent clean turn after re-prompting must not resurrect the
			// stale max_output_tokens capture as a spurious truncation note.
			await manager.completeSession(sessionId, {
				type: "result",
				subtype: "success",
				duration_ms: 1,
				duration_api_ms: 1,
				is_error: false,
				num_turns: 1,
				result: "clean turn after resume",
				stop_reason: null,
				total_cost_usd: 0,
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation: null,
				},
				modelUsage: {},
				permission_denials: [],
				uuid: "result-after-stale",
				session_id: "sdk-session",
			} as any);

			const postedContents = postActivitySpy.mock.calls.map(
				(call: any[]) => call[1],
			);
			expect(postedContents.some((c: any) => c?.type === "error")).toBe(false);
		});
	});

	it("marks session as Error when result is_error is true even if subtype is 'success'", async () => {
		// Reproduces the case where the SDK encodes some hard failures (notably
		// "Prompt is too long" on a too-large resume) as a result message
		// with subtype: "success" AND is_error: true, with the error text
		// in `result`. Cyrus used to gate the status flip on subtype only,
		// so the session was mis-flipped to Complete despite is_error
		// being true — diverging from the error type activity that
		// addResultEntry correctly posts to Linear.
		await manager.completeSession(sessionId, {
			type: "result",
			subtype: "success",
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: true,
			num_turns: 1,
			result: "Prompt is too long",
			stop_reason: null,
			total_cost_usd: 0,
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation: null,
			},
			modelUsage: {},
			permission_denials: [],
			uuid: "result-prompt-too-long",
			session_id: "sdk-session",
		} as any);

		expect(manager.getSession(sessionId)?.status).toBe(
			AgentSessionStatus.Error,
		);
		// And the user-visible Linear activity must be an error, with the
		// SDK's `result` text as the body (not the assistant buffer).
		const errorActivity = postActivitySpy.mock.calls.find(
			(call: any[]) => call[1]?.type === "error",
		);
		expect(errorActivity).toBeDefined();
		expect(errorActivity![1].body).toBe("Prompt is too long");
	});

	it("posts actual error message to Linear for usage limit errors (not generic)", async () => {
		const usageLimitError =
			"You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Feb 16th, 2026 8:09 PM.";

		await manager.completeSession(sessionId, {
			type: "result",
			subtype: "error_during_execution",
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: true,
			num_turns: 1,
			errors: [usageLimitError],
			stop_reason: null,
			total_cost_usd: 0,
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation: null,
			},
			modelUsage: {},
			permission_denials: [],
			uuid: "result-3",
			session_id: "sdk-session",
		} as any);

		const postActivityCalls = postActivitySpy.mock.calls;
		const errorActivity = postActivityCalls.find(
			(call: any[]) => call[1]?.type === "error",
		);
		expect(errorActivity).toBeDefined();
		expect(errorActivity![1].body).toBe(usageLimitError);
	});
});
