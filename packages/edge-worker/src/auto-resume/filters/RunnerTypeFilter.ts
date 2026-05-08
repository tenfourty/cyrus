import type { CyrusAgentSession } from "cyrus-core";
import type { ResumeFilter, SkipReason } from "../types.js";

/**
 * v1 auto-resume only handles Claude sessions. Gemini, Codex, and Cursor
 * runners have different resume semantics that need their own validation
 * before they can be auto-respawned at startup.
 */
export class RunnerTypeFilter implements ResumeFilter {
	readonly name = "runner-type";
	readonly requiresIssueState = false;

	evaluate(session: CyrusAgentSession): SkipReason | null {
		if (session.geminiSessionId) return "runner-not-supported";
		if (session.codexSessionId) return "runner-not-supported";
		if (session.cursorSessionId) return "runner-not-supported";
		return null;
	}
}
