import type {
	SDKAssistantMessage,
	SDKAssistantMessageError,
	SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentPendingWork } from "cyrus-core";
import { AgentSessionStatus } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";

/**
 * Task A2: a Claude turn cut off at the per-turn output-token cap arrives as
 * a `subtype:"success"`, `is_error:false` result — the same envelope as a
 * clean turn — so `completeSession` marks it `Complete`. That status decision
 * must NOT change (reclassifying to `Error` would fire `reconcileAndReap`
 * against a runner that warm/held-open mode keeps alive). Instead, the
 * truncation is surfaced as a visible error-type note posted as the LAST
 * activity, since Linear infers session state from the last activity's
 * content type rather than our internal `AgentSessionStatus`.
 */

const PENDING_WORK: AgentPendingWork = {
	sessionCrons: [
		{
			id: "cron-1",
			schedule: "27 12 * * *",
			recurring: false,
			prompt: "WAKEUP: check the CI run and report status.",
		},
	],
	backgroundTasks: [],
};

function buildAssistantMessage(opts: {
	text: string;
	error?: SDKAssistantMessageError;
}): SDKAssistantMessage {
	return {
		type: "assistant",
		session_id: "claude-session",
		parent_tool_use_id: null,
		uuid: `uuid-assistant-${Math.random()}`,
		...(opts.error && { error: opts.error }),
		message: {
			id: "msg_1",
			type: "message",
			role: "assistant",
			model: "claude",
			stop_reason: "end_turn",
			stop_sequence: null,
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
			},
			content: [{ type: "text", text: opts.text }],
		},
	} as unknown as SDKAssistantMessage;
}

function buildSuccessResult(
	overrides: Partial<SDKResultMessage> = {},
): SDKResultMessage {
	return {
		type: "result",
		subtype: "success",
		is_error: false,
		result: "",
		session_id: "claude-session",
		duration_ms: 1000,
		num_turns: 1,
		stop_reason: null,
		...overrides,
	} as unknown as SDKResultMessage;
}

describe("AgentSessionManager max_output_tokens truncation", () => {
	let manager: AgentSessionManager;
	let mockActivitySink: IActivitySink;
	let postActivitySpy: ReturnType<typeof vi.fn>;
	const sessionId = "test-session-truncation";
	const issueId = "issue-truncation";

	function setup(platform: "linear" | "github" = "linear") {
		mockActivitySink = {
			id: "test-workspace",
			postActivity: vi.fn().mockResolvedValue({ activityId: "a-1" }),
			createAgentSession: vi.fn().mockResolvedValue("s-1"),
		};
		postActivitySpy = mockActivitySink.postActivity as ReturnType<typeof vi.fn>;

		manager = new AgentSessionManager();
		manager.createCyrusAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "TEST-TRUNC",
				title: "Truncation Test",
				description: "test",
				branchName: "test-trunc",
			},
			{ path: "/tmp/workspace", isGitWorktree: false },
			platform,
		);
		if (platform !== "linear") {
			// Non-Linear platforms don't get an externalSessionId by default
			// (only Linear sessions post activities today). Set one directly so
			// the regular response CAN sync — proving the truncation note is
			// specifically gated on trackerId, not on activity-sink plumbing.
			(manager as any).sessions.get(sessionId).externalSessionId =
				"ext-github-1";
		}
		manager.setActivitySink(sessionId, mockActivitySink);
	}

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("truncation via assistant error only (no stop_reason fallback) posts an error note as the last activity, status stays Complete", async () => {
		setup("linear");

		await manager.handleClaudeMessage(
			sessionId,
			buildAssistantMessage({
				text: "Working on the implementation, here is part one of the...",
				error: "max_output_tokens",
			}),
		);
		await manager.handleClaudeMessage(
			sessionId,
			buildSuccessResult({ result: "", stop_reason: null }),
		);

		expect(manager.getSession(sessionId)?.status).toBe(
			AgentSessionStatus.Complete,
		);

		const postedContents = postActivitySpy.mock.calls.map(
			([, content]) => content,
		);
		expect(postedContents.length).toBeGreaterThan(0);
		const last = postedContents[postedContents.length - 1];
		expect(last.type).toBe("error");
		expect(last.body).toMatch(/output-token limit/i);
	});

	it("clears the capture after a turn: a subsequent clean turn posts no error note", async () => {
		setup("linear");

		// Turn 1: truncated.
		await manager.handleClaudeMessage(
			sessionId,
			buildAssistantMessage({
				text: "Truncated turn text",
				error: "max_output_tokens",
			}),
		);
		await manager.handleClaudeMessage(
			sessionId,
			buildSuccessResult({ result: "" }),
		);

		postActivitySpy.mockClear();

		// Turn 2: clean.
		await manager.handleClaudeMessage(
			sessionId,
			buildAssistantMessage({ text: "All done now." }),
		);
		await manager.handleClaudeMessage(
			sessionId,
			buildSuccessResult({ result: "" }),
		);

		expect(manager.getSession(sessionId)?.status).toBe(
			AgentSessionStatus.Complete,
		);
		const postedContents = postActivitySpy.mock.calls.map(
			([, content]) => content,
		);
		expect(postedContents.some((c: any) => c?.type === "error")).toBe(false);
		const last = postedContents[postedContents.length - 1];
		expect(last.type).toBe("response");
		expect(last.body).toBe("All done now.");
	});

	it("clean success (no assistant error, no stop_reason max_tokens) posts no error note", async () => {
		setup("linear");

		await manager.handleClaudeMessage(
			sessionId,
			buildAssistantMessage({ text: "Everything went fine." }),
		);
		await manager.handleClaudeMessage(
			sessionId,
			buildSuccessResult({ result: "" }),
		);

		expect(manager.getSession(sessionId)?.status).toBe(
			AgentSessionStatus.Complete,
		);
		const postedContents = postActivitySpy.mock.calls.map(
			([, content]) => content,
		);
		expect(postedContents.some((c: any) => c?.type === "error")).toBe(false);
	});

	it("non-Linear tracker: a max_output_tokens turn posts no error note even though activities sync", async () => {
		setup("github");

		await manager.handleClaudeMessage(
			sessionId,
			buildAssistantMessage({
				text: "Truncated on a GitHub-tracked session",
				error: "max_output_tokens",
			}),
		);
		await manager.handleClaudeMessage(
			sessionId,
			buildSuccessResult({ result: "" }),
		);

		expect(manager.getSession(sessionId)?.status).toBe(
			AgentSessionStatus.Complete,
		);
		const postedContents = postActivitySpy.mock.calls.map(
			([, content]) => content,
		);
		// The regular response DID sync (proves the sink was reachable)...
		expect(postedContents.some((c: any) => c?.type === "response")).toBe(true);
		// ...but no truncation note was posted.
		expect(postedContents.some((c: any) => c?.type === "error")).toBe(false);
	});

	it("pending work: a truncated turn WITH pending work posts the pending-work thought last and no error note", async () => {
		setup("linear");
		const runnerStub = {
			getPendingWork: () => PENDING_WORK,
			constructor: { name: "ClaudeRunner" },
		} as unknown as Parameters<typeof manager.addAgentRunner>[1];
		manager.addAgentRunner(sessionId, runnerStub);

		await manager.handleClaudeMessage(
			sessionId,
			buildAssistantMessage({
				text: "Truncated but a wakeup is scheduled",
				error: "max_output_tokens",
			}),
		);
		await manager.handleClaudeMessage(
			sessionId,
			buildSuccessResult({ result: "" }),
		);

		expect(manager.getSession(sessionId)?.status).toBe(
			AgentSessionStatus.Complete,
		);
		const postedContents = postActivitySpy.mock.calls.map(
			([, content]) => content,
		);
		expect(postedContents.some((c: any) => c?.type === "error")).toBe(false);
		const last = postedContents[postedContents.length - 1];
		expect(last.type).toBe("thought");
		expect(last.body).toContain("Standing by");
	});
});
