import { describe, expect, it } from "vitest";
import { formatSkipBreakdown } from "../../src/auto-resume/skipBreakdown.js";
import type { SkipReason } from "../../src/auto-resume/types.js";

function repeat(reason: SkipReason, n: number) {
	return Array.from({ length: n }, () => ({ reason }));
}

describe("formatSkipBreakdown", () => {
	it("returns nothing for an empty skip list", () => {
		expect(formatSkipBreakdown([])).toEqual({});
	});

	it("puts low-volume reasons on the actionable line only", () => {
		const breakdown = formatSkipBreakdown([
			...repeat("worktree-missing", 2),
			...repeat("hold-label", 1),
		]);
		expect(breakdown).toEqual({
			actionable: "worktree-missing=2, hold-label=1",
		});
	});

	it("moves a dominant reason to the historical line so actionable stays readable", () => {
		const breakdown = formatSkipBreakdown([
			...repeat("status-not-active", 3889),
			...repeat("worktree-missing", 2),
		]);
		expect(breakdown.actionable).toBe("worktree-missing=2");
		expect(breakdown.historical).toBe("status-not-active=3889");
	});

	it("sorts each line by descending count", () => {
		const breakdown = formatSkipBreakdown([
			...repeat("hold-label", 1),
			...repeat("worktree-missing", 5),
			...repeat("stale", 3),
		]);
		expect(breakdown.actionable).toBe(
			"worktree-missing=5, stale=3, hold-label=1",
		);
	});

	it("treats exactly the threshold as historical", () => {
		const breakdown = formatSkipBreakdown(repeat("stale", 100));
		expect(breakdown.historical).toBe("stale=100");
		expect(breakdown.actionable).toBeUndefined();
	});

	it("treats one below the threshold as actionable", () => {
		const breakdown = formatSkipBreakdown(repeat("stale", 99));
		expect(breakdown.actionable).toBe("stale=99");
		expect(breakdown.historical).toBeUndefined();
	});
});
