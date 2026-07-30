import { describe, expect, it } from "vitest";
import { StalenessFilter } from "../../src/auto-resume/filters/StalenessFilter.js";
import type { ResumeFilterContext } from "../../src/auto-resume/types.js";

const FIXED_NOW = 1_700_000_000_000;

function ctx(maxAgeMs: number): ResumeFilterContext {
	return {
		now: FIXED_NOW,
		config: {
			concurrency: 2,
			staggerMs: [0, 0],
			maxAgeMs,
			maxAttempts: 3,
			holdLabel: "",
		},
		repository: { autoResumeOnStartup: true } as any,
	};
}

function session(updatedAt: number): any {
	return { id: "s1", updatedAt };
}

describe("StalenessFilter", () => {
	const filter = new StalenessFilter();

	it("admits sessions updated within maxAgeMs", () => {
		const oneMinuteAgo = FIXED_NOW - 60_000;
		expect(
			filter.evaluate(session(oneMinuteAgo), ctx(7 * 24 * 3600 * 1000)),
		).toBeNull();
	});

	it("skips sessions updated more than maxAgeMs ago", () => {
		const eightDaysAgo = FIXED_NOW - 8 * 24 * 3600 * 1000;
		expect(
			filter.evaluate(session(eightDaysAgo), ctx(7 * 24 * 3600 * 1000)),
		).toBe("stale");
	});

	it("admits sessions exactly at the threshold (boundary inclusive)", () => {
		const exactlyAtThreshold = FIXED_NOW - 7 * 24 * 3600 * 1000;
		expect(
			filter.evaluate(session(exactlyAtThreshold), ctx(7 * 24 * 3600 * 1000)),
		).toBeNull();
	});

	it("admits sessions when maxAgeMs is 0 (TTL disabled)", () => {
		const veryOld = FIXED_NOW - 365 * 24 * 3600 * 1000;
		expect(filter.evaluate(session(veryOld), ctx(0))).toBeNull();
	});
});
