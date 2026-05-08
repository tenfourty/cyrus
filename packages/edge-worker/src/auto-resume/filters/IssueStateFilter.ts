import type {
	ResumeFilter,
	ResumeFilterContext,
	SkipReason,
} from "../types.js";

const TERMINAL_STATE_TYPES = new Set(["completed", "canceled"]);

/**
 * Sessions whose Linear issue moved to a terminal state during downtime are
 * skipped. The orchestrator pre-fetches the issue snapshot once per session
 * before running the filter pipeline; sessions without an associated issue
 * (e.g. chatbot sessions) bypass this check.
 */
export class IssueStateFilter implements ResumeFilter {
	readonly name = "issue-state";
	readonly requiresIssueState = true;

	evaluate(_session: unknown, ctx: ResumeFilterContext): SkipReason | null {
		const stateType = ctx.issueState?.stateType;
		if (!stateType) return null;
		if (TERMINAL_STATE_TYPES.has(stateType)) return "issue-state-changed";
		return null;
	}
}
