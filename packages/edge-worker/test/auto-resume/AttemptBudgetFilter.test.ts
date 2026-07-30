import { describe, expect, it } from "vitest";
import { AttemptBudgetFilter } from "../../src/auto-resume/filters/AttemptBudgetFilter.js";
import type {
	AutoResumeConfig,
	ResumeFilterContext,
} from "../../src/auto-resume/types.js";

function ctxWith(maxAttempts: number): ResumeFilterContext {
	const config: AutoResumeConfig = {
		concurrency: 2,
		staggerMs: [0, 0],
		maxAgeMs: 0,
		maxAttempts,
		holdLabel: "",
	};
	return { now: Date.now(), config, repository: undefined };
}

function session(autoResumeAttempts?: number): any {
	return { id: "s1", autoResumeAttempts };
}

describe("AttemptBudgetFilter", () => {
	const filter = new AttemptBudgetFilter();

	it("admits a session that has never been attempted", () => {
		expect(filter.evaluate(session(undefined), ctxWith(3))).toBeNull();
	});

	it("admits while attempts remain under the budget", () => {
		expect(filter.evaluate(session(1), ctxWith(3))).toBeNull();
		expect(filter.evaluate(session(2), ctxWith(3))).toBeNull();
	});

	it("skips once the budget is reached", () => {
		expect(filter.evaluate(session(3), ctxWith(3))).toBe(
			"attempt-budget-exhausted",
		);
	});

	it("skips when the counter somehow overshot the budget", () => {
		expect(filter.evaluate(session(11), ctxWith(3))).toBe(
			"attempt-budget-exhausted",
		);
	});

	it("is disabled by maxAttempts === 0", () => {
		expect(filter.evaluate(session(999), ctxWith(0))).toBeNull();
	});

	it("does not consult issue state", () => {
		expect(filter.requiresIssueState).toBe(false);
	});
});
