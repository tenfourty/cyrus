/**
 * Per-turn AI usage telemetry types + formatters.
 *
 * Off by default; enabled via EdgeConfig.telemetry / RepositoryConfig.telemetry.
 * Runner-discriminated union because runners differ sharply on what they
 * report — Claude carries 12+ fields, Codex/Gemini/Cursor carry 3-4 each.
 * Encoding the runner name on every record lets analytics filter for
 * Claude-only fields without forcing zero-fills that would lie.
 */

import type { RunnerType } from "./config-schemas.js";

export interface RunnerTelemetryBase {
	schemaVersion: 1;
	runner: RunnerType;
	sessionId: string;
	entryId: string;
	repoId: string;
	issueIdentifier?: string;
	model: string;
	/** ISO 8601 */
	timestamp: string;
	durationMs: number;
	durationApiMs?: number;
	isError: boolean;
	stopReason?: string;
	costUsd?: number;
	usage: {
		input_tokens: number;
		output_tokens: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
	toolCalls: {
		total: number;
		byName: Record<string, number>;
	};
}

export interface ClaudeProviderExtras {
	cacheCreation?: {
		ephemeral_5m_input_tokens: number;
		ephemeral_1h_input_tokens: number;
	};
	serverToolUse?: { web_search_requests: number };
	modelUsage: Record<
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
	>;
	permissionDenials: Array<{ tool_name: string; tool_use_id: string }>;
}

export interface ClaudeTelemetry extends RunnerTelemetryBase {
	runner: "claude";
	costUsd: number;
	providerExtras: ClaudeProviderExtras;
}

export interface GeminiTelemetry extends RunnerTelemetryBase {
	runner: "gemini";
}

export interface CodexTelemetry extends RunnerTelemetryBase {
	runner: "codex";
}

export interface CursorTelemetry extends RunnerTelemetryBase {
	runner: "cursor";
}

export type RunnerTelemetryRecord =
	| ClaudeTelemetry
	| GeminiTelemetry
	| CodexTelemetry
	| CursorTelemetry;

function compactNumber(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatDuration(ms: number): string {
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const totalSec = Math.round(ms / 1000);
	const m = Math.floor(totalSec / 60);
	const s = totalSec % 60;
	return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function formatCost(cost: number): string {
	return `$${cost.toFixed(4)}`;
}

export function formatTelemetryFooter(r: RunnerTelemetryRecord): string {
	const parts: string[] = [];
	if (typeof r.costUsd === "number" && r.costUsd > 0) {
		parts.push(formatCost(r.costUsd));
	}
	parts.push(
		`${compactNumber(r.usage.input_tokens)} in / ${compactNumber(r.usage.output_tokens)} out`,
	);
	const cache =
		(r.usage.cache_read_input_tokens ?? 0) +
		(r.usage.cache_creation_input_tokens ?? 0);
	if (cache > 0) parts.push(`${compactNumber(cache)} cache`);
	parts.push(formatDuration(r.durationMs));
	parts.push(r.model);
	if (r.toolCalls.total > 0) parts.push(`${r.toolCalls.total} tools`);
	return `\n\n— ${parts.join(" · ")}`;
}

