/**
 * Parse a leading repo-filter tag from a Slack mention message.
 *
 * Recognized syntaxes (must appear at the very start of the message,
 * after optional leading whitespace):
 *   - `[repos=a,b]` or `[repo=name]` (bracketed)
 *   - `repos=a,b` or `repo=name` (unbracketed)
 *
 * Returns the deduplicated list of repo names and the cleaned message
 * text with the tag removed. If no tag is present, returns an empty
 * list and the original text (whitespace untouched).
 */
export function parseSlackRepoTag(text: string): {
	repoNames: string[];
	cleanText: string;
} {
	// Bracketed: [repo=...] or [repos=...] at start (after optional whitespace)
	const bracketed = text.match(/^\s*\[repos?=([a-zA-Z0-9_\-/.,]+)\]\s*/);
	if (bracketed?.[1]) {
		return {
			repoNames: dedupe(splitNames(bracketed[1])),
			cleanText: text.slice(bracketed[0].length).trim(),
		};
	}

	// Unbracketed: repo=... or repos=... at start (after optional whitespace),
	// followed by whitespace or end-of-string
	const unbracketed = text.match(/^\s*repos?=([a-zA-Z0-9_\-/.,]+)(?:\s+|$)/);
	if (unbracketed?.[1]) {
		return {
			repoNames: dedupe(splitNames(unbracketed[1])),
			cleanText: text.slice(unbracketed[0].length).trim(),
		};
	}

	return { repoNames: [], cleanText: text };
}

function splitNames(value: string): string[] {
	return value
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

function dedupe(items: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const item of items) {
		if (!seen.has(item)) {
			seen.add(item);
			result.push(item);
		}
	}
	return result;
}
