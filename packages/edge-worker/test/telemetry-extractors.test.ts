import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { extractTelemetry } from "../src/telemetry-extractors.js";

const claudeResult = {
	type: "result",
	subtype: "success",
	is_error: false,
	duration_ms: 14200,
	duration_api_ms: 12100,
	num_turns: 3,
	total_cost_usd: 0.0421,
	stop_reason: "end_turn",
	session_id: "claude-s1",
	uuid: "u1",
	usage: {
		input_tokens: 12340,
		output_tokens: 1205,
		cache_read_input_tokens: 8400,
		cache_creation_input_tokens: 320,
		cache_creation: {
			ephemeral_5m_input_tokens: 320,
			ephemeral_1h_input_tokens: 0,
		},
		server_tool_use: { web_search_requests: 0 },
	},
	modelUsage: {
		"claude-sonnet-4": {
			inputTokens: 12340,
			outputTokens: 1205,
			cacheReadInputTokens: 8400,
			cacheCreationInputTokens: 320,
			webSearchRequests: 0,
			costUSD: 0.0421,
			contextWindow: 200000,
			maxOutputTokens: 8192,
		},
	},
	permission_denials: [],
	result: "ok",
} as unknown as SDKResultMessage;

const toolCounts = { total: 7, byName: { Bash: 3, Read: 2, Edit: 2 } };

describe("extractTelemetry", () => {
	it("extracts full Claude record with providerExtras", () => {
		const r = extractTelemetry({
			runnerType: "claude",
			resultMessage: claudeResult,
			toolCounts,
			model: "claude-sonnet-4",
			sessionId: "s1",
			entryId: "e1",
			repoId: "r1",
			issueIdentifier: "ABC-1",
		});
		expect(r.runner).toBe("claude");
		expect(r.costUsd).toBe(0.0421);
		expect(r.durationApiMs).toBe(12100);
		expect(r.usage.cache_read_input_tokens).toBe(8400);
		expect(r.toolCalls.total).toBe(7);
		if (r.runner === "claude") {
			expect(r.providerExtras.cacheCreation?.ephemeral_5m_input_tokens).toBe(
				320,
			);
			expect(r.providerExtras.modelUsage["claude-sonnet-4"].costUSD).toBe(
				0.0421,
			);
		}
	});

	it("extracts Codex record without cost or providerExtras", () => {
		const codexResult = {
			type: "result",
			subtype: "success",
			is_error: false,
			duration_ms: 8000,
			num_turns: 1,
			total_cost_usd: 0,
			session_id: "codex-s1",
			usage: {
				input_tokens: 4000,
				output_tokens: 500,
				cache_read_input_tokens: 1000,
				cache_creation_input_tokens: 0,
			},
		} as unknown as SDKResultMessage;
		const r = extractTelemetry({
			runnerType: "codex",
			resultMessage: codexResult,
			toolCounts: { total: 2, byName: { Bash: 2 } },
			model: "gpt-5-codex",
			sessionId: "s2",
			entryId: "e1",
			repoId: "r1",
		});
		expect(r.runner).toBe("codex");
		expect(r.costUsd).toBeUndefined();
		expect("providerExtras" in r).toBe(false);
		expect(r.usage.cache_read_input_tokens).toBe(1000);
	});

	it("handles missing usage fields gracefully (returns zeros)", () => {
		const minimal = {
			type: "result",
			subtype: "error_max_turns",
			is_error: true,
			duration_ms: 500,
			session_id: "g1",
			usage: undefined,
		} as unknown as SDKResultMessage;
		const r = extractTelemetry({
			runnerType: "gemini",
			resultMessage: minimal,
			toolCounts: { total: 0, byName: {} },
			model: "gemini-2.5-pro",
			sessionId: "s3",
			entryId: "e1",
			repoId: "r1",
		});
		expect(r.isError).toBe(true);
		expect(r.usage.input_tokens).toBe(0);
		expect(r.usage.output_tokens).toBe(0);
	});
});
