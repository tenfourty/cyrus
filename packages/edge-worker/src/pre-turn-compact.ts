import type { CyrusAgentSession, ILogger } from "cyrus-core";

/** Inclusive lower bound for a usable auto-compact threshold. */
const MIN_AUTO_COMPACT_THRESHOLD_PERCENT = 1;
/** Inclusive upper bound for a usable auto-compact threshold. */
const MAX_AUTO_COMPACT_THRESHOLD_PERCENT = 99;

/**
 * Validate a configured auto-compact threshold at the point of use.
 *
 * The Zod schema constrains this field to an integer in 1–99, but
 * `ConfigService.load()` never `safeParse`s `~/.cyrus/config.json` against
 * it, so on self-host installs an arbitrary JSON value reaches this code
 * unchecked. Two of those are actively harmful rather than merely ignored:
 *   - `0` / a negative number makes every utilization comparison
 *     (`currentPercent >= threshold`) true, so Cyrus would spawn a full
 *     `/compact` subprocess before literally every resume; and
 *   - a non-numeric value would be stringified straight into
 *     `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (e.g. `=abc`) for the child process.
 *
 * Anything outside an integer 1–99 is therefore dropped with a warning and
 * treated as "not configured" — the guard disables itself and no env var is
 * injected, which is the same safe posture as omitting the field.
 */
export function resolveAutoCompactThresholdPercent(
	value: unknown,
	logger: ILogger,
	source = "autoCompactThresholdPercent",
): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value)) {
		logger.warn(
			`Ignoring ${source}: expected an integer between ${MIN_AUTO_COMPACT_THRESHOLD_PERCENT} and ${MAX_AUTO_COMPACT_THRESHOLD_PERCENT}, got ${JSON.stringify(value)}. Auto-compact threshold left unset.`,
		);
		return undefined;
	}
	if (
		value < MIN_AUTO_COMPACT_THRESHOLD_PERCENT ||
		value > MAX_AUTO_COMPACT_THRESHOLD_PERCENT
	) {
		logger.warn(
			`Ignoring ${source}=${value}: outside the supported range ${MIN_AUTO_COMPACT_THRESHOLD_PERCENT}–${MAX_AUTO_COMPACT_THRESHOLD_PERCENT}. Auto-compact threshold left unset.`,
		);
		return undefined;
	}
	return value;
}

/**
 * Fallback context-window map, used only when the SDK has not yet reported a
 * real window for the session's model.
 *
 * The authoritative source is the SDK itself: every result message carries
 * `modelUsage: Record<string, ModelUsage>`, and each `ModelUsage` includes a
 * `contextWindow`. Cyrus persists that alongside `usage`, and
 * `getModelContextWindow` below prefers it. This map only covers the gap
 * before the first result message lands (or when the recorded `modelUsage`
 * has no entry for the session's model).
 *
 * Unknown models fall back to 200k, the modern Anthropic default; the only
 * exception is the `[1m]` Opus variant which advertises a 1M-token window.
 */
function getFallbackModelContextWindow(model: string | undefined): number {
	if (!model) return 200_000;
	if (model.includes("[1m]") || /(?:^|-)1m$/i.test(model)) return 1_000_000;
	return 200_000;
}

/** Shape of the persisted `metadata.modelUsage` (SDK `ModelUsage`, per model). */
type RecordedModelUsage = Record<
	string,
	{ contextWindow?: number } | undefined
>;

/**
 * Resolve the session model's context window, preferring the real value the
 * SDK reported over the built-in fallback map.
 *
 * `modelUsage` is keyed by the model id the API billed against, which is
 * normally the same string the init message put in `metadata.model`. Only an
 * exact key match is honored — guessing across other entries would risk
 * picking up a subagent's smaller/larger window and silently mis-sizing the
 * threshold, so an unmatched model falls through to the map instead.
 */
function getModelContextWindow(
	model: string | undefined,
	modelUsage: unknown,
): number {
	if (model && modelUsage && typeof modelUsage === "object") {
		const reported = (modelUsage as RecordedModelUsage)[model]?.contextWindow;
		if (typeof reported === "number" && reported > 0) {
			return reported;
		}
	}
	return getFallbackModelContextWindow(model);
}

export interface ShouldCompactBeforeTurnInput {
	session: CyrusAgentSession;
	/**
	 * Resolved Cyrus auto-compact threshold (1–99, already validated by
	 * `resolveAutoCompactThresholdPercent`). When `undefined`, the pre-turn
	 * guard is disabled — the operator hasn't opted in and the SDK's own
	 * auto-compaction is the only mechanism.
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
 *
 * KNOWN OVER-COUNT — the numbers below are an UPPER BOUND, not the live
 * context size. `session.metadata.usage` is a verbatim copy of
 * `SDKResultMessage.usage` (see `AgentSessionManager.completeSession`), and
 * that field is CUMULATIVE over every API request the turn made, not the last
 * request's usage. Verified against `@anthropic-ai/claude-agent-sdk@0.3.205`:
 * the bundled engine folds each response's usage into a running per-model
 * accumulator and derives the result message's `usage` by summing it, and a
 * live 7-response probe produced `cache_read_input_tokens: 133184` — the exact
 * sum of the per-response values `0, 0, 17664, 25509, 25588, 32172, 32251`,
 * over 4x the largest single response.
 *
 * Consequence: on a tool-heavy turn the sum below can exceed the real
 * transcript size by an order of magnitude, so a configured threshold will
 * fire far earlier than the operator asked for — possibly on nearly every
 * resume. That direction is fail-safe (compacting too eagerly never wedges a
 * session, it only costs summarization calls), which is why the behavior is
 * left as-is here rather than changed speculatively. Sizing the live context
 * correctly needs a different source than the result message — e.g. tracking
 * the LAST assistant message's `message.usage` per turn — and that is a
 * deliberate follow-up, not a drive-by.
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

	const windowTokens = getModelContextWindow(
		input.session.metadata?.model,
		input.session.metadata?.modelUsage,
	);
	const currentPercent = (totalTokens / windowTokens) * 100;

	if (currentPercent >= input.thresholdPercent) {
		return { compact: true, currentPercent, reason: "over-threshold" };
	}
	return { compact: false, currentPercent, reason: "under-threshold" };
}
