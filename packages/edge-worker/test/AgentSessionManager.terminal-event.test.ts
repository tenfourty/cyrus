import { AgentSessionStatus } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";

/**
 * Regression tests for the "Linear session completion never triggers
 * persistence" bug: AgentSessionManager mutates session.status in memory
 * (Complete/Error/Stale) but never emits a signal the EdgeWorker can hook
 * into to call savePersistedState. Auto-resume then trusts stale on-disk
 * status=active and respawns completed sessions on next restart.
 *
 * Fix: emit `session_terminal` from updateSessionStatus whenever status
 * lands on a terminal-ish value. EdgeWorker subscribes once and persists.
 */
describe("AgentSessionManager terminal-status emit", () => {
	let manager: AgentSessionManager;
	let mockActivitySink: IActivitySink;
	const sessionId = "test-session-terminal";
	const issueId = "issue-terminal";

	beforeEach(() => {
		mockActivitySink = {
			id: "test-workspace",
			postActivity: vi.fn().mockResolvedValue({ activityId: "a-1" }),
			createAgentSession: vi.fn().mockResolvedValue("s-1"),
		};

		manager = new AgentSessionManager();
		manager.createCyrusAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "TEST-TERM",
				title: "Terminal Emit Test",
				description: "test",
				branchName: "test-term",
			},
			{ path: "/tmp/workspace", isGitWorktree: false },
		);
		manager.setActivitySink(sessionId, mockActivitySink);
	});

	const buildResult = (subtype: "success" | "error_during_execution") =>
		({
			type: "result",
			subtype,
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: subtype !== "success",
			num_turns: 1,
			...(subtype === "success"
				? { result: "ok", stop_reason: null }
				: { errors: ["boom"], stop_reason: null }),
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
			uuid: "result-x",
			session_id: "sdk-session",
		}) as any;

	it("emits session_terminal once when a session completes successfully", async () => {
		const events: Array<{ sessionId: string }> = [];
		manager.on("session_terminal", (e) => events.push(e));

		await manager.completeSession(sessionId, buildResult("success"));

		expect(manager.getSession(sessionId)?.status).toBe(
			AgentSessionStatus.Complete,
		);
		expect(events).toEqual([{ sessionId }]);
	});

	it("emits session_terminal when a session ends with execution error", async () => {
		const events: Array<{ sessionId: string }> = [];
		manager.on("session_terminal", (e) => events.push(e));

		await manager.completeSession(
			sessionId,
			buildResult("error_during_execution"),
		);

		expect(manager.getSession(sessionId)?.status).toBe(
			AgentSessionStatus.Error,
		);
		expect(events).toEqual([{ sessionId }]);
	});

	it("emits session_terminal when stop-requested forces session into Error", async () => {
		const events: Array<{ sessionId: string }> = [];
		manager.on("session_terminal", (e) => events.push(e));

		manager.requestSessionStop(sessionId);
		await manager.completeSession(sessionId, buildResult("success"));

		expect(manager.getSession(sessionId)?.status).toBe(
			AgentSessionStatus.Error,
		);
		expect(events).toEqual([{ sessionId }]);
	});

	it("markSessionStopped flips an Active session to Error and emits session_terminal", async () => {
		const terminal = vi.fn();
		manager.on("session_terminal", terminal);

		await manager.markSessionStopped(sessionId);

		expect(manager.getSession(sessionId)?.status).toBe(
			AgentSessionStatus.Error,
		);
		expect(terminal).toHaveBeenCalledWith({ sessionId });
	});

	it("markSessionStale flips an Active session to Stale and emits session_terminal once", async () => {
		const terminal = vi.fn();
		manager.on("session_terminal", terminal);

		await manager.markSessionStale(sessionId);

		expect(manager.getSession(sessionId)?.status).toBe(
			AgentSessionStatus.Stale,
		);
		expect(terminal).toHaveBeenCalledWith({ sessionId });
		expect(terminal).toHaveBeenCalledTimes(1);
	});
});
