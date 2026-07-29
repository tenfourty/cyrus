import { existsSync } from "node:fs";
import type { CyrusAgentSession } from "cyrus-core";
import type { ResumeFilter, SkipReason } from "../types.js";

/**
 * Sessions whose worktree paths are no longer present on disk are skipped.
 * Worktrees can disappear during downtime (manual operator cleanup, multi-repo
 * cleanup logic, crash mid-delete). Resuming against a missing worktree fails
 * silently — we'd rather retire the session loudly so the operator knows.
 */
export class WorktreeExistsFilter implements ResumeFilter {
	readonly name = "worktree-exists";
	readonly requiresIssueState = false;

	evaluate(session: CyrusAgentSession): SkipReason | null {
		const paths = this.collectWorktreePaths(session);
		for (const p of paths) {
			if (!existsSync(p)) return "worktree-missing";
		}
		return null;
	}

	private collectWorktreePaths(session: CyrusAgentSession): string[] {
		const repoPaths = session.workspace.repoPaths;
		if (repoPaths && Object.keys(repoPaths).length > 0) {
			return Object.values(repoPaths);
		}
		return [session.workspace.path];
	}
}
