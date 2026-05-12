import type { CyrusAgentSession, ILogger } from "cyrus-core";

/**
 * Built-in Cyrus context-window map. The SDK doesn't expose model →
 * context-window introspection, so Cyrus carries a small mapping for the
 * models it actually ships. Unknown models fall back to 200k, which is
 * the modern Anthropic default; the only exception today is the
 * `[1m]` Opus variant which advertises a 1M-token window.
 *
 * Operators on custom or future model strings can over- or under-estimate
 * by tuning `autoCompactThresholdPercent` lower rather than touching this
 * map — the fallback bias is conservative on purpose.
 */
function getModelContextWindow(model: string | undefined): number {
	if (!model) return 200_000;
	if (model.includes("[1m]") || /(?:^|-)1m$/i.test(model)) return 1_000_000;
	return 200_000;
}

export interface ShouldCompactBeforeTurnInput {
	session: CyrusAgentSession;
	/**
	 * Resolved Cyrus auto-compact threshold (1–99). When `undefined`, the
	 * pre-turn guard is disabled — the operator hasn't opted in and the
	 * SDK's own auto-compaction is the only mechanism.
	 */
	thresholdPercent: number | undefined;
	logger: ILogger;
}

export interface ShouldCompactBeforeTurnResult {
	/** Whether the caller should invoke `/compact` before forwarding the next prompt. */
	compact: boolean;
	/**
	 * Effective context-window utilization (0–100+), or undefined when no
	 * usage signal is available yet. Useful for log lines and the
	 * user-facing thought activity.
	 */
	currentPercent?: number;
	/**
	 * Why the decision came out as it did. Used in logs to make the
	 * resume-time guard's behavior visible to operators grepping journalctl.
	 */
	reason?:
		| "no-threshold-configured"
		| "no-usage-yet"
		| "zero-tokens"
		| "under-threshold"
		| "over-threshold";
}

/**
 * Decide whether Cyrus should run `/compact` against a Claude session
 * before forwarding the next user prompt.
 *
 * Background: the SDK's built-in auto-compaction fires mid-turn when the
 * NEXT request would exceed the configured threshold. That works in
 * normal flow but leaves stopped/wedged sessions stranded — a session
 * stopped at 80% of context will, on the next user prompt or restart-time
 * auto-resume, rehydrate the full transcript before the SDK has a chance
 * to compact. If the rehydrate already pushes past the wall, every
 * subsequent prompt fails with "Prompt is too long".
 *
 * Cyrus defends against that here by checking the session's last
 * recorded usage against the configured threshold (same number that drives
 * `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`). When over, the caller spawns a
 * one-shot `/compact` turn against the existing `claudeSessionId` before
 * forwarding the user's actual prompt.
 *
 * The function is pure — no I/O, no SDK calls — so it is trivially
 * unit-testable and safe to invoke from any resume callsite (user prompt,
 * auto-resume orchestrator drain, manual re-ping).
 */
export function shouldCompactBeforeTurn(
	input: ShouldCompactBeforeTurnInput,
): ShouldCompactBeforeTurnResult {
	if (input.thresholdPercent === undefined) {
		return { compact: false, reason: "no-threshold-configured" };
	}

	const usage = input.session.metadata?.usage as
		| {
				input_tokens?: number;
				cache_read_input_tokens?: number;
				cache_creation_input_tokens?: number;
		  }
		| undefined;

	if (!usage) {
		return { compact: false, reason: "no-usage-yet" };
	}

	const totalTokens =
		(usage.input_tokens ?? 0) +
		(usage.cache_read_input_tokens ?? 0) +
		(usage.cache_creation_input_tokens ?? 0);

	if (totalTokens === 0) {
		return { compact: false, reason: "zero-tokens" };
	}

	const windowTokens = getModelContextWindow(input.session.metadata?.model);
	const currentPercent = (totalTokens / windowTokens) * 100;

	if (currentPercent >= input.thresholdPercent) {
		return { compact: true, currentPercent, reason: "over-threshold" };
	}
	return { compact: false, currentPercent, reason: "under-threshold" };
}
