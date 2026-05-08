import { describe, expect, it } from "vitest";
import { RunnerTypeFilter } from "../../src/auto-resume/filters/RunnerTypeFilter.js";
import type { ResumeFilterContext } from "../../src/auto-resume/types.js";

const ctx: ResumeFilterContext = {
	now: Date.now(),
	config: { concurrency: 2, staggerMs: [0, 0], maxAgeMs: 0, holdLabel: "" },
	repository: undefined,
};

function session(overrides: Record<string, unknown> = {}): any {
	return { id: "s1", ...overrides };
}

describe("RunnerTypeFilter", () => {
	const filter = new RunnerTypeFilter();

	it("admits sessions with claudeSessionId set", () => {
		expect(
			filter.evaluate(session({ claudeSessionId: "claude-abc" }), ctx),
		).toBeNull();
	});

	it("admits sessions with no runner ID set yet (claude is the default)", () => {
		expect(filter.evaluate(session(), ctx)).toBeNull();
	});

	it("skips sessions with geminiSessionId set", () => {
		expect(filter.evaluate(session({ geminiSessionId: "g-1" }), ctx)).toBe(
			"runner-not-supported",
		);
	});

	it("skips sessions with codexSessionId set", () => {
		expect(filter.evaluate(session({ codexSessionId: "c-1" }), ctx)).toBe(
			"runner-not-supported",
		);
	});

	it("skips sessions with cursorSessionId set", () => {
		expect(filter.evaluate(session({ cursorSessionId: "x-1" }), ctx)).toBe(
			"runner-not-supported",
		);
	});
});
