import { describe, expect, it } from "vitest";
import { formatTerminalStopMessage } from "../src/terminal-stop-message";

describe("formatTerminalStopMessage", () => {
	it("uses Done wording for completed state", () => {
		expect(formatTerminalStopMessage("ENG-524", "completed")).toBe(
			"Session stopped — ENG-524 was marked Done.",
		);
	});

	it("uses Canceled wording for canceled state", () => {
		expect(formatTerminalStopMessage("ENG-524", "canceled")).toBe(
			"Session stopped — ENG-524 was Canceled.",
		);
	});

	it("falls back to closed wording when state type is unknown", () => {
		expect(formatTerminalStopMessage("ENG-524", undefined)).toBe(
			"Session stopped — ENG-524 was closed.",
		);
		expect(formatTerminalStopMessage("ENG-524", null)).toBe(
			"Session stopped — ENG-524 was closed.",
		);
		expect(formatTerminalStopMessage("ENG-524", "started")).toBe(
			"Session stopped — ENG-524 was closed.",
		);
	});
});
