import { describe, expect, it } from "vitest";
import { RepositoryOptInFilter } from "../../src/auto-resume/filters/RepositoryOptInFilter.js";
import type { ResumeFilterContext } from "../../src/auto-resume/types.js";

function ctx(repository: any): ResumeFilterContext {
	return {
		now: Date.now(),
		config: {
			concurrency: 2,
			staggerMs: [0, 0],
			maxAgeMs: 0,
			maxAttempts: 3,
			holdLabel: "",
		},
		repository,
	};
}

const session: any = { id: "s1" };

describe("RepositoryOptInFilter", () => {
	const filter = new RepositoryOptInFilter();

	it("admits sessions whose repository has autoResumeOnStartup === true", () => {
		expect(
			filter.evaluate(session, ctx({ autoResumeOnStartup: true })),
		).toBeNull();
	});

	it("skips sessions whose repository has autoResumeOnStartup === false", () => {
		expect(filter.evaluate(session, ctx({ autoResumeOnStartup: false }))).toBe(
			"repo-opt-out",
		);
	});

	it("skips sessions whose repository omits autoResumeOnStartup (default false)", () => {
		expect(filter.evaluate(session, ctx({}))).toBe("repo-opt-out");
	});

	it("skips sessions whose repository config is missing entirely", () => {
		expect(filter.evaluate(session, ctx(undefined))).toBe("repo-opt-out");
	});
});
