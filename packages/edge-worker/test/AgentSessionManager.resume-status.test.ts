import { AgentSessionStatus } from "cyrus-core";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";

describe("AgentSessionManager.markSessionResuming", () => {
	let manager: AgentSessionManager;
	const sessionId = "test-session-resume";
	const issueId = "issue-resume";

	beforeEach(() => {
		manager = new AgentSessionManager();
		manager.createCyrusAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "TEST-RESUME",
				title: "Resume Status Test",
				description: "test",
				branchName: "test-resume",
			},
			{
				path: "/tmp/workspace",
				isGitWorktree: false,
			},
		);
	});

	it("flips status from Complete back to Active", async () => {
		await manager.completeSession(sessionId, {
			type: "result",
			subtype: "success",
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: false,
			num_turns: 1,
			result: "done",
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
			AgentSessionStatus.Complete,
		);

		manager.markSessionResuming(sessionId);

		expect(manager.getSession(sessionId)?.status).toBe(
			AgentSessionStatus.Active,
		);
	});

	it("flips status from Error back to Active (operator re-prompt after error)", async () => {
		await manager.completeSession(sessionId, {
			type: "result",
			subtype: "error_during_execution",
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: true,
			num_turns: 1,
			errors: ["boom"],
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
			uuid: "result-err",
			session_id: "sdk-session",
		} as any);

		expect(manager.getSession(sessionId)?.status).toBe(
			AgentSessionStatus.Error,
		);

		manager.markSessionResuming(sessionId);

		expect(manager.getSession(sessionId)?.status).toBe(
			AgentSessionStatus.Active,
		);
	});

	it("is a no-op for an unknown session id", () => {
		expect(() => manager.markSessionResuming("does-not-exist")).not.toThrow();
		expect(manager.getSession("does-not-exist")).toBeUndefined();
	});

	it("bumps updatedAt and leaves status alone when already Active", () => {
		const before = manager.getSession(sessionId);
		expect(before?.status).toBe(AgentSessionStatus.Active);
		const beforeUpdated = before?.updatedAt ?? 0;

		// Force a measurable wall-clock gap so updatedAt strictly advances.
		const now = Date.now();
		while (Date.now() === now) {
			/* spin */
		}

		manager.markSessionResuming(sessionId);

		const after = manager.getSession(sessionId);
		expect(after?.status).toBe(AgentSessionStatus.Active);
		expect((after?.updatedAt ?? 0) >= beforeUpdated).toBe(true);
	});

	it("getActiveSessions includes a session that was Complete then resumed", async () => {
		await manager.completeSession(sessionId, {
			type: "result",
			subtype: "success",
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: false,
			num_turns: 1,
			result: "done",
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

		// Pre-resume: orchestrator-style query excludes the session.
		const beforeIds = manager.getActiveSessions().map((s) => s.id);
		expect(beforeIds).not.toContain(sessionId);

		manager.markSessionResuming(sessionId);

		// Post-resume: visible to the orchestrator's source-of-sessions.
		const afterIds = manager.getActiveSessions().map((s) => s.id);
		expect(afterIds).toContain(sessionId);
	});
});
