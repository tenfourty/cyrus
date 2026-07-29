/**
 * A configured fallback model — either a single model name/alias, or an ordered
 * chain of them tried in turn when the primary is overloaded or unavailable.
 */
export type FallbackModelConfig = string | string[];

/**
 * Collapse a configured fallback model into the single-string form the Claude
 * Agent SDK / CLI expects.
 *
 * The `--fallback-model` flag (and the programmatic `fallbackModel` option it
 * backs) accepts a comma-separated list and tries each entry in order, so a
 * chain is expressed by joining with commas. This is the one place cyrus turns
 * its `string | string[]` config into that wire form.
 *
 * - `undefined`, empty string, or empty/all-blank array → `undefined`, so the
 *   caller's `||` fallthrough to the next-priority config still fires (an empty
 *   array is otherwise truthy in JS and would wrongly short-circuit it).
 * - A single string is split on `,` before trimming/deduping. Env-var-only
 *   config (e.g. `CYRUS_CLAUDE_DEFAULT_FALLBACK_MODEL`, which can only ever be
 *   a scalar string) is the sole way some operators can express a chain, so
 *   `"minimax, haiku"` must behave identically to `["minimax", "haiku"]`
 *   rather than yielding a single `" haiku"`-suffixed hop.
 * - Entries are trimmed; blank entries are dropped; duplicates are removed
 *   preserving first-seen order (a repeat is wasted retry budget). This
 *   function has no knowledge of the primary model, so it cannot detect (and
 *   does not guard against) a chain entry equal to the primary — that would
 *   trip the SDK's "fallback ≠ main" guard. Callers that know both values
 *   (e.g. ClaudeRunner, which has `config.model` in scope) must filter those
 *   out themselves after calling this function.
 */
export function normalizeFallbackModel(
	value: FallbackModelConfig | undefined,
): string | undefined {
	const list = Array.isArray(value)
		? value
		: value === undefined
			? []
			: value.split(",");

	const seen = new Set<string>();
	const cleaned: string[] = [];
	for (const entry of list) {
		const trimmed = entry.trim();
		if (trimmed === "" || seen.has(trimmed)) continue;
		seen.add(trimmed);
		cleaned.push(trimmed);
	}

	return cleaned.length > 0 ? cleaned.join(",") : undefined;
}
