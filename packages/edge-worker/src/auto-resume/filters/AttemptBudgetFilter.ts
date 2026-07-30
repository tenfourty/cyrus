import type { CyrusAgentSession } from "cyrus-core";
import type {
	ResumeFilter,
	ResumeFilterContext,
	SkipReason,
} from "../types.js";

/**
 * Stops auto-resume from retrying a session that can never succeed.
 *
 * `StalenessFilter` cannot serve as the backstop here: resuming a session
 * touches `session.updatedAt` (via `addAgentRunner`, and again when
 * `resumeAgentSession` persists state), so every attempt refreshes the very
 * timestamp staleness keys off. A session that fails before ever reaching a
 * result message — e.g. its issue was deleted, so the resume path throws
 * `Failed to fetch full issue details` — would otherwise be retried on
 * every single boot, forever.
 *
 * The orchestrator increments `session.autoResumeAttempts` *before* each
 * attempt and resets it to 0 after one succeeds, so the counter measures
 * consecutive failures rather than lifetime resumes. Once it reaches
 * `config.maxAttempts` the session is skipped with a loud, distinct reason.
 */
export class AttemptBudgetFilter implements ResumeFilter {
	readonly name = "attempt-budget";
	readonly requiresIssueState = false;

	evaluate(
		session: CyrusAgentSession,
		ctx: ResumeFilterContext,
	): SkipReason | null {
		const max = ctx.config.maxAttempts;
		if (max <= 0) return null;
		const attempts = session.autoResumeAttempts ?? 0;
		return attempts >= max ? "attempt-budget-exhausted" : null;
	}
}
