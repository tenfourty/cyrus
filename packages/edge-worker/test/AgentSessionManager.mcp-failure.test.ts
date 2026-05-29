import type { SDKSystemMessage } from "cyrus-claude-runner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";

/**
 * Surfacing failed MCP server attachments at session init.
 *
 * Without this, an MCP server that fails to attach (e.g. slack-mcp-server
 * crashing on a missing_scope channel-enumeration boot error, or the Linear
 * MCP server rejecting a stale token) silently drops the tools it would have
 * exposed. The operator sees nothing in the timeline and the agent improvises
 * around the missing tools — sometimes fabricating an explanation ("I'm scoped
 * to research/Q&A by design"). This test pins the observable behavior.
 */
describe("AgentSessionManager - MCP server failure surfacing", () => {
	let manager: AgentSessionManager;
	let mockActivitySink: IActivitySink;
	let postActivitySpy: any;
	const sessionId = "test-session-mcp";
	const issueId = "issue-mcp";

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
				identifier: "TEST-MCP",
				title: "Test Issue",
				description: "Test",
				branchName: "test",
			},
			{ path: "/test", isGitWorktree: false },
		);
		manager.setActivitySink(sessionId, mockActivitySink);
	});

	function initMessage(
		mcp_servers: Array<{ name: string; status: string; error?: string }>,
	): SDKSystemMessage {
		return {
			type: "system",
			subtype: "init",
			session_id: "claude-1",
			model: "claude-sonnet-4-6",
			tools: [],
			mcp_servers,
			permissionMode: "default",
			apiKeySource: "claude_desktop",
		} as unknown as SDKSystemMessage;
	}

	function findMcpFailureCall(serverName: string) {
		return postActivitySpy.mock.calls.find(
			(call: any) =>
				call[1]?.type === "thought" &&
				typeof call[1]?.body === "string" &&
				call[1].body.includes("MCP server") &&
				call[1].body.includes(serverName),
		);
	}

	it("posts a timeline thought for each failed or needs-auth MCP server at init", async () => {
		await manager.handleClaudeMessage(
			sessionId,
			initMessage([
				{ name: "linear", status: "connected" },
				{ name: "slack", status: "failed", error: "missing_scope" },
				{ name: "cyrus-tools", status: "needs-auth" },
			]),
		);

		expect(findMcpFailureCall("slack")).toBeTruthy();
		expect(findMcpFailureCall("cyrus-tools")).toBeTruthy();
		// Connected servers do not produce a failure activity.
		expect(findMcpFailureCall("linear")).toBeFalsy();
	});

	it("does not surface transient `pending` or operator-intentional `disabled` servers", async () => {
		await manager.handleClaudeMessage(
			sessionId,
			initMessage([
				{ name: "cyrus-docs", status: "pending" },
				{ name: "cyrus-tools", status: "disabled" },
			]),
		);

		expect(findMcpFailureCall("cyrus-docs")).toBeFalsy();
		expect(findMcpFailureCall("cyrus-tools")).toBeFalsy();
	});

	it("dedupes the surfaced thought across re-emitted init messages (resumes)", async () => {
		const init = initMessage([
			{ name: "slack", status: "failed", error: "missing_scope" },
		]);
		await manager.handleClaudeMessage(sessionId, init);
		// Resume / continuation — runner re-emits init for the same session.
		await manager.handleClaudeMessage(sessionId, init);

		const slackCalls = postActivitySpy.mock.calls.filter(
			(call: any) =>
				call[1]?.type === "thought" &&
				typeof call[1]?.body === "string" &&
				call[1].body.includes("slack"),
		);
		expect(slackCalls).toHaveLength(1);
	});

	it("includes the underlying error message in the surfaced thought when the SDK provides one", async () => {
		await manager.handleClaudeMessage(
			sessionId,
			initMessage([
				{ name: "slack", status: "failed", error: "missing_scope" },
			]),
		);

		const call = findMcpFailureCall("slack");
		expect(call).toBeTruthy();
		expect(call[1].body).toContain("missing_scope");
	});

	it("posts nothing extra when every MCP server is connected", async () => {
		await manager.handleClaudeMessage(
			sessionId,
			initMessage([
				{ name: "linear", status: "connected" },
				{ name: "slack", status: "connected" },
			]),
		);

		const anyMcpThought = postActivitySpy.mock.calls.find(
			(call: any) =>
				call[1]?.type === "thought" &&
				typeof call[1]?.body === "string" &&
				call[1].body.includes("MCP server"),
		);
		expect(anyMcpThought).toBeFalsy();
	});
});
