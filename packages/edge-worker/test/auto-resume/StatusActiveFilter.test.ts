import { AgentSessionStatus } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { StatusActiveFilter } from "../../src/auto-resume/filters/StatusActiveFilter.js";
import type { ResumeFilterContext } from "../../src/auto-resume/types.js";

const ctx: ResumeFilterContext = {
	now: Date.now(),
	config: {
		concurrency: 2,
		staggerMs: [0, 0],
		maxAgeMs: 0,
		maxAttempts: 3,
		holdLabel: "",
	},
	repository: undefined,
};

function session(status: AgentSessionStatus): any {
	return { id: "s1", status };
}

describe("StatusActiveFilter", () => {
	const filter = new StatusActiveFilter();

	it("admits sessions with status === Active", () => {
		expect(filter.evaluate(session(AgentSessionStatus.Active), ctx)).toBeNull();
	});

	it("skips sessions with status === Complete (status-not-active)", () => {
		expect(filter.evaluate(session(AgentSessionStatus.Complete), ctx)).toBe(
			"status-not-active",
		);
	});

	it("skips sessions with status === Error", () => {
		expect(filter.evaluate(session(AgentSessionStatus.Error), ctx)).toBe(
			"status-not-active",
		);
	});

	it("skips sessions with status === AwaitingInput", () => {
		expect(
			filter.evaluate(session(AgentSessionStatus.AwaitingInput), ctx),
		).toBe("status-not-active");
	});

	it("skips sessions with status === Pending", () => {
		expect(filter.evaluate(session(AgentSessionStatus.Pending), ctx)).toBe(
			"status-not-active",
		);
	});

	it("does not consult issue state", () => {
		expect(filter.requiresIssueState).toBe(false);
	});
});
