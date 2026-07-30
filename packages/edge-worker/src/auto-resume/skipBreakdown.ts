import type { SkipReason } from "./types.js";

/**
 * Skip count at or above which a reason is treated as expected background
 * noise rather than something an operator should act on. Heuristic — low
 * enough that real ops problems (worktree-missing, hold-label,
 * issue-state-unavailable) stay on the actionable line.
 */
export const HISTORICAL_SKIP_THRESHOLD = 100;

export interface SkipBreakdown {
	/** Low-volume reasons worth reading. Omitted when there are none. */
	actionable?: string;
	/** Dominant reasons that are expected on long-lived installs. */
	historical?: string;
}

/**
 * Group auto-resume skip reasons for logging, splitting dominant reasons
 * from actionable ones.
 *
 * Without the split, one runaway count (`status-not-active` in the thousands
 * on an install that has accumulated completed sessions) sits on the same
 * line as `worktree-missing=2` and buries it. Both lines are sorted
 * descending by count.
 */
export function formatSkipBreakdown(
	skipped: ReadonlyArray<{ reason: SkipReason }>,
): SkipBreakdown {
	const grouped = new Map<string, number>();
	for (const { reason } of skipped) {
		grouped.set(reason, (grouped.get(reason) ?? 0) + 1);
	}

	const sorted = [...grouped.entries()].sort((a, b) => b[1] - a[1]);
	const render = (entries: Array<[string, number]>) =>
		entries.map(([reason, count]) => `${reason}=${count}`).join(", ");

	const actionable = sorted.filter(([, n]) => n < HISTORICAL_SKIP_THRESHOLD);
	const historical = sorted.filter(([, n]) => n >= HISTORICAL_SKIP_THRESHOLD);

	const result: SkipBreakdown = {};
	if (actionable.length > 0) result.actionable = render(actionable);
	if (historical.length > 0) result.historical = render(historical);
	return result;
}
