import type {
	ResumeFilter,
	ResumeFilterContext,
	SkipReason,
} from "../types.js";

/**
 * Operator pause sentinel. When the issue carries the configured hold label
 * (default `cyrus:hold`), the session is skipped at startup so an
 * intentionally-paused thread does not get re-poked. Match is
 * case-insensitive. An empty `holdLabel` disables the check.
 */
export class HoldLabelFilter implements ResumeFilter {
	readonly name = "hold-label";
	readonly requiresIssueState = true;

	evaluate(_session: unknown, ctx: ResumeFilterContext): SkipReason | null {
		const holdLabel = ctx.config.holdLabel;
		if (!holdLabel) return null;
		const labels = ctx.issueState?.labels ?? [];
		if (labels.length === 0) return null;
		const target = holdLabel.toLowerCase();
		for (const label of labels) {
			if (label.toLowerCase() === target) return "hold-label";
		}
		return null;
	}
}
