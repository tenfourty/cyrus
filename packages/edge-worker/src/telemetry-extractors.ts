import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RunnerTelemetryRecord, RunnerType } from "cyrus-core";

export interface ExtractInput {
	runnerType: RunnerType;
	resultMessage: SDKResultMessage;
	toolCounts: { total: number; byName: Record<string, number> };
	model: string;
	sessionId: string;
	entryId: string;
	repoId: string;
	issueIdentifier?: string;
}

function safeUsage(m: SDKResultMessage): {
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
} {
	const u = (m as { usage?: Record<string, unknown> }).usage;
	if (!u || typeof u !== "object") {
		return { input_tokens: 0, output_tokens: 0 };
	}
	return {
		input_tokens: Number(u.input_tokens) || 0,
		output_tokens: Number(u.output_tokens) || 0,
		cache_read_input_tokens:
			typeof u.cache_read_input_tokens === "number"
				? u.cache_read_input_tokens
				: undefined,
		cache_creation_input_tokens:
			typeof u.cache_creation_input_tokens === "number"
				? u.cache_creation_input_tokens
				: undefined,
	};
}

/**
 * Convert an SDKResultMessage into a runner-discriminated telemetry record.
 *
 * Claude carries the full economics (cost, cache 5m/1h split, modelUsage,
 * permission_denials). Codex/Gemini/Cursor carry a strict subset — their
 * runner adapters coerce output into SDKResultMessage shape but most
 * Claude-specific fields are absent or zero-filled. We omit costUsd /
 * providerExtras on non-Claude records so the store doesn't lie about
 * zero costs the runner couldn't report.
 */
export function extractTelemetry(input: ExtractInput): RunnerTelemetryRecord {
	const {
		runnerType,
		resultMessage,
		toolCounts,
		model,
		sessionId,
		entryId,
		repoId,
		issueIdentifier,
	} = input;
	const m = resultMessage as unknown as Record<string, unknown>;
	const base = {
		schemaVersion: 1 as const,
		sessionId,
		entryId,
		repoId,
		issueIdentifier,
		model,
		timestamp: new Date().toISOString(),
		durationMs: Number(m.duration_ms) || 0,
		isError: Boolean(m.is_error),
		stopReason: typeof m.stop_reason === "string" ? m.stop_reason : undefined,
		usage: safeUsage(resultMessage),
		toolCalls: toolCounts,
	};

	if (runnerType === "claude") {
		const u = (m.usage ?? {}) as Record<string, unknown>;
		const cc = u.cache_creation as
			| {
					ephemeral_5m_input_tokens?: number;
					ephemeral_1h_input_tokens?: number;
				}
			| undefined;
		const stu = u.server_tool_use as
			| { web_search_requests?: number }
			| undefined;
		const denials = Array.isArray(m.permission_denials)
			? (m.permission_denials as Array<{
					tool_name: string;
					tool_use_id: string;
				}>)
			: [];
		return {
			...base,
			runner: "claude",
			durationApiMs:
				typeof m.duration_api_ms === "number" ? m.duration_api_ms : undefined,
			costUsd: Number(m.total_cost_usd) || 0,
			providerExtras: {
				cacheCreation:
					cc && typeof cc.ephemeral_5m_input_tokens === "number"
						? {
								ephemeral_5m_input_tokens: cc.ephemeral_5m_input_tokens ?? 0,
								ephemeral_1h_input_tokens: cc.ephemeral_1h_input_tokens ?? 0,
							}
						: undefined,
				serverToolUse:
					stu && typeof stu.web_search_requests === "number"
						? { web_search_requests: stu.web_search_requests }
						: undefined,
				modelUsage: (m.modelUsage ?? {}) as Record<
					string,
					{
						inputTokens: number;
						outputTokens: number;
						cacheReadInputTokens: number;
						cacheCreationInputTokens: number;
						webSearchRequests: number;
						costUSD: number;
						contextWindow: number;
						maxOutputTokens: number;
					}
				>,
				permissionDenials: denials.map((d) => ({
					tool_name: d.tool_name,
					tool_use_id: d.tool_use_id,
				})),
			},
		};
	}

	return { ...base, runner: runnerType } as RunnerTelemetryRecord;
}
