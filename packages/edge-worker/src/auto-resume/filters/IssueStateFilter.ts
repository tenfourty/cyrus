import type {
	ResumeFilter,
	ResumeFilterContext,
	SkipReason,
} from "../types.js";

/**
 * Issue states that mean "nobody is expecting an agent to be working on this
 * right now". `completed` / `canceled` are the obvious terminal pair, but
 * `backlog` and `triage` matter just as much for auto-resume: moving an issue
 * back to the backlog during downtime is how a human says "park this", and
 * respawning an agent on it at the next boot overrides that.
 *
 * `unstarted` (Todo) is deliberately NOT here — an in-flight session on a Todo
 * issue is a normal transient state, not a signal.
 */
const NON_RESUMABLE_STATE_TYPES = new Set([
	"completed",
	"canceled",
	"backlog",
	"triage",
]);

/**
 * Sessions whose issue is no longer in a state that expects agent work are
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
		if (NON_RESUMABLE_STATE_TYPES.has(stateType)) return "issue-state-changed";
		return null;
	}
}
