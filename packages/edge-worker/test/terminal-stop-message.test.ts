import { describe, expect, it } from "vitest";
import { formatTerminalStopMessage } from "../src/terminal-stop-message";

describe("formatTerminalStopMessage", () => {
	it("uses Done wording for completed state", () => {
		expect(formatTerminalStopMessage("AIN-524", "completed")).toBe(
			"Session stopped — AIN-524 was marked Done.",
		);
	});

	it("uses Canceled wording for canceled state", () => {
		expect(formatTerminalStopMessage("AIN-524", "canceled")).toBe(
			"Session stopped — AIN-524 was Canceled.",
		);
	});

	it("falls back to closed wording when state type is unknown", () => {
		expect(formatTerminalStopMessage("AIN-524", undefined)).toBe(
			"Session stopped — AIN-524 was closed.",
		);
		expect(formatTerminalStopMessage("AIN-524", null)).toBe(
			"Session stopped — AIN-524 was closed.",
		);
		expect(formatTerminalStopMessage("AIN-524", "started")).toBe(
			"Session stopped — AIN-524 was closed.",
		);
	});
});
