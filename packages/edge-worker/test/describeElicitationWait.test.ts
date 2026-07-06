import { describe, expect, it } from "vitest";
import { describeElicitationWait } from "../src/AskUserQuestionHandler.js";

/**
 * Unit tests for the elicitation-timeout duration copy. The default (15 min)
 * reads as minutes; the regression this guards against is a sub-minute custom
 * CYRUS_ELICITATION_TIMEOUT_MS rendering the nonsensical "0 minutes" (C-M1).
 */
describe("describeElicitationWait", () => {
	it("renders the 15-minute default as whole minutes", () => {
		expect(describeElicitationWait(15 * 60 * 1000)).toBe("15 minutes");
	});

	it("renders a sub-minute duration as seconds, not '0 minutes'", () => {
		expect(describeElicitationWait(20 * 1000)).toBe("20 seconds");
		expect(describeElicitationWait(30 * 1000)).toBe("30 seconds");
	});

	it("uses singular units for exactly one minute / one second", () => {
		expect(describeElicitationWait(60 * 1000)).toBe("1 minute");
		expect(describeElicitationWait(1000)).toBe("1 second");
	});

	it("rounds to the nearest whole minute for multi-minute durations", () => {
		expect(describeElicitationWait(2 * 60 * 1000)).toBe("2 minutes");
		expect(describeElicitationWait(90 * 1000)).toBe("2 minutes"); // 1.5 min rounds up
	});
});
