import { describe, expect, it } from "vitest";
import {
	formatTelemetryFooter,
	type RunnerTelemetryRecord,
} from "./RunnerTelemetry.js";

const claudeRecord: RunnerTelemetryRecord = {
	schemaVersion: 1,
	runner: "claude",
	sessionId: "s1",
	entryId: "e1",
	repoId: "r1",
	issueIdentifier: "ABC-1",
	model: "claude-sonnet-4",
	timestamp: "2026-05-12T10:00:00.000Z",
	durationMs: 14200,
	durationApiMs: 12100,
	isError: false,
	stopReason: "end_turn",
	costUsd: 0.0421,
	usage: {
		input_tokens: 12340,
		output_tokens: 1205,
		cache_read_input_tokens: 8400,
		cache_creation_input_tokens: 320,
	},
	toolCalls: { total: 7, byName: { Bash: 3, Read: 2, Edit: 2 } },
	providerExtras: {
		cacheCreation: {
			ephemeral_5m_input_tokens: 320,
			ephemeral_1h_input_tokens: 0,
		},
		modelUsage: {},
		permissionDenials: [],
	},
};

const codexRecord: RunnerTelemetryRecord = {
	schemaVersion: 1,
	runner: "codex",
	sessionId: "s2",
	entryId: "e2",
	repoId: "r1",
	model: "gpt-5-codex",
	timestamp: "2026-05-12T10:01:00.000Z",
	durationMs: 8000,
	isError: false,
	usage: {
		input_tokens: 4000,
		output_tokens: 500,
		cache_read_input_tokens: 1000,
	},
	toolCalls: { total: 2, byName: { Bash: 2 } },
};

describe("formatTelemetryFooter", () => {
	it("renders full Claude footer with cost + cache + tools", () => {
		expect(formatTelemetryFooter(claudeRecord)).toBe(
			"\n\n— $0.0421 · 12.3k in / 1.2k out · 8.7k cache · 14.2s · claude-sonnet-4 · 7 tools",
		);
	});

	it("omits cost segment when runner reports no cost", () => {
		expect(formatTelemetryFooter(codexRecord)).toBe(
			"\n\n— 4.0k in / 500 out · 1.0k cache · 8.0s · gpt-5-codex · 2 tools",
		);
	});

	it("omits cache segment when no cache tokens", () => {
		const noCache: RunnerTelemetryRecord = {
			...codexRecord,
			usage: { input_tokens: 100, output_tokens: 50 },
		};
		expect(formatTelemetryFooter(noCache)).toBe(
			"\n\n— 100 in / 50 out · 8.0s · gpt-5-codex · 2 tools",
		);
	});

	it("omits tools segment when zero tool calls", () => {
		const noTools: RunnerTelemetryRecord = {
			...codexRecord,
			toolCalls: { total: 0, byName: {} },
		};
		expect(formatTelemetryFooter(noTools)).toBe(
			"\n\n— 4.0k in / 500 out · 1.0k cache · 8.0s · gpt-5-codex",
		);
	});
});

describe("formatTelemetryFooter — M suffix at >= 1M tokens", () => {
	it("renders M-suffix for high-cache totals (1M-window Claude sessions)", () => {
		const heavyCache: RunnerTelemetryRecord = {
			...claudeRecord,
			usage: {
				input_tokens: 22,
				output_tokens: 9700,
				cache_read_input_tokens: 2_276_000,
				cache_creation_input_tokens: 164_400,
			},
			toolCalls: { total: 16, byName: { Bash: 14, Edit: 2 } },
		};
		const out = formatTelemetryFooter(heavyCache);
		expect(out).toContain("22 in / 9.7k out");
		expect(out).toContain("2.4M cache");
	});
});
