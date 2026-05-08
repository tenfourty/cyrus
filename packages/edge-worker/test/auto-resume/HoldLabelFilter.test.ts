import { describe, expect, it } from "vitest";
import { HoldLabelFilter } from "../../src/auto-resume/filters/HoldLabelFilter.js";
import type {
	IssueStateSnapshot,
	ResumeFilterContext,
} from "../../src/auto-resume/types.js";

function ctx(
	issueState: IssueStateSnapshot | undefined,
	holdLabel = "cyrus:hold",
): ResumeFilterContext {
	return {
		now: Date.now(),
		config: { concurrency: 2, staggerMs: [0, 0], maxAgeMs: 0, holdLabel },
		repository: { autoResumeOnStartup: true } as any,
		issueState,
	};
}

const session: any = { id: "s1" };

describe("HoldLabelFilter", () => {
	const filter = new HoldLabelFilter();

	it("skips sessions whose issue carries the configured hold label", () => {
		expect(
			filter.evaluate(
				session,
				ctx({ stateType: "started", labels: ["cyrus:hold"] }),
			),
		).toBe("hold-label");
	});

	it("admits sessions whose issue does not carry the hold label", () => {
		expect(
			filter.evaluate(session, ctx({ stateType: "started", labels: ["bug"] })),
		).toBeNull();
	});

	it("matches the hold label case-insensitively", () => {
		expect(
			filter.evaluate(
				session,
				ctx({ stateType: "started", labels: ["Cyrus:Hold"] }),
			),
		).toBe("hold-label");
	});

	it("admits sessions when issueState was not pre-fetched", () => {
		expect(filter.evaluate(session, ctx(undefined))).toBeNull();
	});

	it("admits sessions when the hold label is empty (feature disabled)", () => {
		expect(
			filter.evaluate(
				session,
				ctx({ stateType: "started", labels: ["cyrus:hold"] }, ""),
			),
		).toBeNull();
	});
});
