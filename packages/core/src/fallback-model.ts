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
 * - Entries are trimmed; blank entries are dropped; duplicates are removed
 *   preserving first-seen order (a repeat is wasted retry budget, and a chain
 *   entry equal to the primary can trip the SDK's "fallback ≠ main" guard).
 */
export function normalizeFallbackModel(
	value: FallbackModelConfig | undefined,
): string | undefined {
	const list = Array.isArray(value)
		? value
		: value === undefined
			? []
			: [value];

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
