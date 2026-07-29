import type {
	ResumeFilter,
	ResumeFilterContext,
	SkipReason,
} from "../types.js";

/**
 * Per-repository opt-in. Sessions whose primary repository does not set
 * `autoResumeOnStartup: true` are skipped. Default-off ensures existing
 * installs see no behavior change after upgrading.
 */
export class RepositoryOptInFilter implements ResumeFilter {
	readonly name = "repository-opt-in";
	readonly requiresIssueState = false;

	evaluate(_session: unknown, ctx: ResumeFilterContext): SkipReason | null {
		const repo = ctx.repository as
			| { autoResumeOnStartup?: boolean }
			| undefined;
		if (repo?.autoResumeOnStartup === true) return null;
		return "repo-opt-out";
	}
}
