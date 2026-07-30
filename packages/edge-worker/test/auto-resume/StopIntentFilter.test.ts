import { AgentSessionStatus } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { StopIntentFilter } from "../../src/auto-resume/filters/StopIntentFilter.js";
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

describe("StopIntentFilter", () => {
	const filter = new StopIntentFilter();

	it("admits sessions with no recorded stop", () => {
		expect(
			filter.evaluate(
				{ id: "s1", status: AgentSessionStatus.Active } as any,
				ctx,
			),
		).toBeNull();
	});

	it("skips a session the user stopped, even though its status is still Active", () => {
		// This is the exact shape a force-killed stop leaves on disk: the SDK
		// throws AbortError, no result message is emitted, so nothing ever
		// flips status away from Active.
		const stopped = {
			id: "s1",
			status: AgentSessionStatus.Active,
			stopRequestedAt: Date.now() - 5_000,
		} as any;

		expect(filter.evaluate(stopped, ctx)).toBe("user-stopped");
	});

	it("treats a zero timestamp as a real stop, not as absent", () => {
		expect(
			filter.evaluate(
				{
					id: "s1",
					status: AgentSessionStatus.Active,
					stopRequestedAt: 0,
				} as any,
				ctx,
			),
		).toBe("user-stopped");
	});

	it("admits again once the stamp is cleared by a fresh prompt", () => {
		expect(
			filter.evaluate(
				{
					id: "s1",
					status: AgentSessionStatus.Active,
					stopRequestedAt: undefined,
				} as any,
				ctx,
			),
		).toBeNull();
	});

	it("does not consult issue state", () => {
		expect(filter.requiresIssueState).toBe(false);
	});
});
