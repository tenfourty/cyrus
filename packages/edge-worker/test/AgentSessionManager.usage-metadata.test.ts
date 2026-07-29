import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeMessageFormatter } from "cyrus-claude-runner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import { shouldCompactBeforeTurn } from "../src/pre-turn-compact";
import type { IActivitySink } from "../src/sinks/IActivitySink";

/**
 * Usage metadata recorded on a session drives the pre-turn `/compact` guard.
 * Two properties are load-bearing:
 *
 *  1. `modelUsage` must be persisted alongside `usage`. Each entry carries the
 *     model's real `contextWindow`, which is the authoritative denominator for
 *     context-utilization math — a built-in model → window table can only ever
 *     be a stale guess.
 *  2. `usage` must be clearable after a successful out-of-band `/compact`.
 *     It is only refreshed by a result message, so left alone it still
 *     describes the pre-compact transcript and the very next resume would
 *     re-compact an already-compacted session — a real cost, since every
 *     `/compact` is a full summarization model call.
 */

const sessionId = "session-usage-metadata";
const issueId = "issue-usage-metadata";

function buildResult(overrides: Record<string, unknown>): SDKResultMessage {
	return {
		type: "result",
		subtype: "success",
		is_error: false,
		result: "done",
		session_id: "claude-session",
		duration_ms: 1000,
		num_turns: 2,
		total_cost_usd: 0.42,
		...overrides,
	} as unknown as SDKResultMessage;
}

describe("AgentSessionManager usage metadata", () => {
	let manager: AgentSessionManager;

	beforeEach(() => {
		vi.clearAllMocks();
		const mockActivitySink: IActivitySink = {
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
				identifier: "CYPACK-1",
				title: "Usage metadata",
				description: "",
				branchName: "test-branch",
			},
			{ path: "/tmp/workspace", isGitWorktree: false },
		);
		manager.setActivitySink(sessionId, mockActivitySink);
		const formatter = new ClaudeMessageFormatter();
		manager.addAgentRunner(sessionId, {
			getFormatter: () => formatter,
			constructor: { name: "ClaudeRunner" },
		} as unknown as Parameters<typeof manager.addAgentRunner>[1]);
	});

	it("persists modelUsage from the result message so the real contextWindow survives the turn", async () => {
		await manager.handleClaudeMessage(
			sessionId,
			buildResult({
				usage: { input_tokens: 120_000 },
				modelUsage: {
					"claude-sonnet-4-6": {
						inputTokens: 120_000,
						outputTokens: 500,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						webSearchRequests: 0,
						costUSD: 0.42,
						contextWindow: 1_000_000,
						maxOutputTokens: 64_000,
					},
				},
			}),
		);

		const session = manager.getSession(sessionId);
		expect(session?.metadata?.modelUsage?.["claude-sonnet-4-6"]).toMatchObject({
			contextWindow: 1_000_000,
		});
	});

	it("makes the guard use the reported window rather than the built-in fallback", async () => {
		await manager.handleClaudeMessage(
			sessionId,
			buildResult({
				usage: { input_tokens: 300_000 },
				modelUsage: {
					"claude-sonnet-4-6": { contextWindow: 1_000_000 },
				},
			}),
		);
		const session = manager.getSession(sessionId);
		// The init message normally sets metadata.model; set it directly here
		// so this test exercises only the usage/window plumbing.
		if (session?.metadata) session.metadata.model = "claude-sonnet-4-6";

		// 300k against the 200k fallback map would be 150% (compact);
		// against the reported 1M window it is 30% (no compact).
		const decision = shouldCompactBeforeTurn({
			session: session as never,
			thresholdPercent: 50,
			logger: {
				info: () => {},
				warn: () => {},
				error: () => {},
				debug: () => {},
			} as never,
		});
		expect(decision.compact).toBe(false);
		expect(decision.currentPercent).toBeCloseTo(30);
	});

	it("clearRecordedUsage drops stale usage so the next resume does not re-compact", async () => {
		await manager.handleClaudeMessage(
			sessionId,
			buildResult({
				usage: { input_tokens: 180_000 },
				modelUsage: { "claude-sonnet-4-6": { contextWindow: 200_000 } },
			}),
		);
		const session = manager.getSession(sessionId);
		if (session?.metadata) session.metadata.model = "claude-sonnet-4-6";

		const logger = {
			info: () => {},
			warn: () => {},
			error: () => {},
			debug: () => {},
		} as never;

		// Before: 90% of a 200k window — the guard fires.
		expect(
			shouldCompactBeforeTurn({
				session: session as never,
				thresholdPercent: 50,
				logger,
			}).compact,
		).toBe(true);

		manager.clearRecordedUsage(sessionId);

		// After a successful /compact the stale figure is gone, so the guard
		// stands down until the next result message reports the real size.
		const after = manager.getSession(sessionId);
		expect(after?.metadata?.usage).toBeUndefined();
		const decision = shouldCompactBeforeTurn({
			session: after as never,
			thresholdPercent: 50,
			logger,
		});
		expect(decision.compact).toBe(false);
		expect(decision.reason).toBe("no-usage-yet");
	});

	it("clearRecordedUsage keeps modelUsage — compaction does not change the context window", async () => {
		await manager.handleClaudeMessage(
			sessionId,
			buildResult({
				usage: { input_tokens: 180_000 },
				modelUsage: { "claude-sonnet-4-6": { contextWindow: 1_000_000 } },
			}),
		);

		manager.clearRecordedUsage(sessionId);

		const session = manager.getSession(sessionId);
		expect(session?.metadata?.modelUsage?.["claude-sonnet-4-6"]).toMatchObject({
			contextWindow: 1_000_000,
		});
	});

	it("clearRecordedUsage is a no-op for an unknown session", () => {
		expect(() => manager.clearRecordedUsage("no-such-session")).not.toThrow();
	});
});
