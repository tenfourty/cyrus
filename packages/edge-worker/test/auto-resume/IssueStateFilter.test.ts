import { describe, expect, it } from "vitest";
import { IssueStateFilter } from "../../src/auto-resume/filters/IssueStateFilter.js";
import type {
	IssueStateSnapshot,
	ResumeFilterContext,
} from "../../src/auto-resume/types.js";

function ctx(issueState: IssueStateSnapshot | undefined): ResumeFilterContext {
	return {
		now: Date.now(),
		config: { concurrency: 2, staggerMs: [0, 0], maxAgeMs: 0, holdLabel: "" },
		repository: { autoResumeOnStartup: true } as any,
		issueState,
	};
}

const session: any = { id: "s1" };

describe("IssueStateFilter", () => {
	const filter = new IssueStateFilter();

	it("admits sessions whose issue state type is 'started'", () => {
		expect(
			filter.evaluate(session, ctx({ stateType: "started", labels: [] })),
		).toBeNull();
	});

	it("admits sessions whose issue state type is 'unstarted'", () => {
		expect(
			filter.evaluate(session, ctx({ stateType: "unstarted", labels: [] })),
		).toBeNull();
	});

	it("skips sessions whose issue state type is 'completed'", () => {
		expect(
			filter.evaluate(session, ctx({ stateType: "completed", labels: [] })),
		).toBe("issue-state-changed");
	});

	it("skips sessions whose issue state type is 'canceled'", () => {
		expect(
			filter.evaluate(session, ctx({ stateType: "canceled", labels: [] })),
		).toBe("issue-state-changed");
	});

	it("admits sessions when issueState was not pre-fetched (chatbot/no-issue session)", () => {
		expect(filter.evaluate(session, ctx(undefined))).toBeNull();
	});
});
