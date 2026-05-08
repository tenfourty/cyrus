import type { CyrusAgentSession } from "cyrus-core";
import type {
	ResumeFilter,
	ResumeFilterContext,
	SkipReason,
} from "../types.js";

/**
 * Sessions whose `updatedAt` is older than the configured TTL are skipped.
 * Stops Cyrus from respawning agents on issues whose threads went quiet
 * weeks ago and were never explicitly closed. `maxAgeMs === 0` disables.
 */
export class StalenessFilter implements ResumeFilter {
	readonly name = "staleness";
	readonly requiresIssueState = false;

	evaluate(
		session: CyrusAgentSession,
		ctx: ResumeFilterContext,
	): SkipReason | null {
		if (ctx.config.maxAgeMs <= 0) return null;
		const age = ctx.now - session.updatedAt;
		if (age > ctx.config.maxAgeMs) return "stale";
		return null;
	}
}
