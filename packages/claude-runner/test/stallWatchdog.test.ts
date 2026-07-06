import { describe, expect, it } from "vitest";
import {
	pendingToolDelta,
	resolveStallConfig,
	selectStallBudget,
} from "../src/stallWatchdog.js";

describe("selectStallBudget", () => {
	const cfg = { idleMs: 600_000, toolMs: 1_800_000 };

	it("returns idleMs when no tool is in flight", () => {
		expect(selectStallBudget(0, cfg)).toBe(600_000);
	});

	it("returns toolMs when exactly one tool is in flight", () => {
		expect(selectStallBudget(1, cfg)).toBe(1_800_000);
	});

	it("returns toolMs when multiple tools are in flight", () => {
		expect(selectStallBudget(3, cfg)).toBe(1_800_000);
	});

	it("returns idleMs for a negative (shouldn't-happen) count", () => {
		expect(selectStallBudget(-1, cfg)).toBe(600_000);
	});
});

describe("pendingToolDelta", () => {
	it("returns +2 for an assistant message with 2 tool_use blocks", () => {
		const message = {
			type: "assistant",
			message: {
				content: [
					{ type: "tool_use", name: "Read", input: {} },
					{ type: "tool_use", name: "Bash", input: {} },
				],
			},
		};
		expect(pendingToolDelta(message)).toBe(2);
	});

	it("returns +1 for an assistant message with tool_use + text blocks", () => {
		const message = {
			type: "assistant",
			message: {
				content: [
					{ type: "text", text: "thinking..." },
					{ type: "tool_use", name: "Read", input: {} },
				],
			},
		};
		expect(pendingToolDelta(message)).toBe(1);
	});

	it("returns -1 for a user message with 1 tool_result block", () => {
		const message = {
			type: "user",
			message: {
				content: [{ type: "tool_result", tool_use_id: "abc", content: "ok" }],
			},
		};
		expect(pendingToolDelta(message)).toBe(-1);
	});

	it("returns -2 for a user message with 2 tool_result blocks", () => {
		const message = {
			type: "user",
			message: {
				content: [
					{ type: "tool_result", tool_use_id: "a", content: "ok" },
					{ type: "tool_result", tool_use_id: "b", content: "ok" },
				],
			},
		};
		expect(pendingToolDelta(message)).toBe(-2);
	});

	it("returns 0 for an assistant message with only text blocks", () => {
		const message = {
			type: "assistant",
			message: { content: [{ type: "text", text: "hello" }] },
		};
		expect(pendingToolDelta(message)).toBe(0);
	});

	it("returns 0 for a result message", () => {
		expect(pendingToolDelta({ type: "result" })).toBe(0);
	});

	it("returns 0 for a system message", () => {
		expect(pendingToolDelta({ type: "system" })).toBe(0);
	});

	it("returns 0 for undefined without throwing", () => {
		expect(pendingToolDelta(undefined)).toBe(0);
	});

	it("returns 0 for an empty object without throwing", () => {
		expect(pendingToolDelta({})).toBe(0);
	});

	it("returns 0 when content is not an array, without throwing", () => {
		expect(
			pendingToolDelta({ type: "assistant", message: { content: "oops" } }),
		).toBe(0);
		expect(pendingToolDelta({ type: "user", message: { content: null } })).toBe(
			0,
		);
		expect(pendingToolDelta({ type: "assistant", message: undefined })).toBe(0);
		expect(pendingToolDelta({ type: "assistant" })).toBe(0);
	});
});

describe("resolveStallConfig", () => {
	it("returns the confirmed defaults for an empty env", () => {
		expect(resolveStallConfig({})).toEqual({
			enabled: true,
			idleMs: 600_000,
			toolMs: 1_800_000,
		});
	});

	it("disables when CYRUS_STALL_WATCHDOG is '0'", () => {
		expect(resolveStallConfig({ CYRUS_STALL_WATCHDOG: "0" }).enabled).toBe(
			false,
		);
	});

	it("disables when CYRUS_STALL_WATCHDOG is 'false'", () => {
		expect(resolveStallConfig({ CYRUS_STALL_WATCHDOG: "false" }).enabled).toBe(
			false,
		);
	});

	it("enables for '1', unset, or other values", () => {
		expect(resolveStallConfig({ CYRUS_STALL_WATCHDOG: "1" }).enabled).toBe(
			true,
		);
		expect(resolveStallConfig({}).enabled).toBe(true);
		expect(
			resolveStallConfig({ CYRUS_STALL_WATCHDOG: "anything" }).enabled,
		).toBe(true);
	});

	it("parses a valid CYRUS_STALL_IDLE_TIMEOUT_MS override", () => {
		expect(
			resolveStallConfig({ CYRUS_STALL_IDLE_TIMEOUT_MS: "120000" }).idleMs,
		).toBe(120_000);
	});

	it("falls back to the idle default for 0, negative, or non-numeric overrides", () => {
		expect(
			resolveStallConfig({ CYRUS_STALL_IDLE_TIMEOUT_MS: "0" }).idleMs,
		).toBe(600_000);
		expect(
			resolveStallConfig({ CYRUS_STALL_IDLE_TIMEOUT_MS: "-5" }).idleMs,
		).toBe(600_000);
		expect(
			resolveStallConfig({ CYRUS_STALL_IDLE_TIMEOUT_MS: "abc" }).idleMs,
		).toBe(600_000);
	});

	it("parses a valid CYRUS_STALL_TOOL_TIMEOUT_MS override", () => {
		expect(
			resolveStallConfig({ CYRUS_STALL_TOOL_TIMEOUT_MS: "900000" }).toolMs,
		).toBe(900_000);
	});

	it("falls back to the tool default for 0, negative, or non-numeric overrides", () => {
		expect(
			resolveStallConfig({ CYRUS_STALL_TOOL_TIMEOUT_MS: "0" }).toolMs,
		).toBe(1_800_000);
		expect(
			resolveStallConfig({ CYRUS_STALL_TOOL_TIMEOUT_MS: "-5" }).toolMs,
		).toBe(1_800_000);
		expect(
			resolveStallConfig({ CYRUS_STALL_TOOL_TIMEOUT_MS: "abc" }).toolMs,
		).toBe(1_800_000);
	});
});
