/**
 * Classifies why a ClaudeRunner's query loop threw, so the runner can tell a
 * Cyrus-initiated stop (via stop()) from an out-of-band death (crash / OOM /
 * external SIGTERM). A Cyrus stop() can surface as EITHER an AbortError OR
 * "exited with code 143", so error-shape alone is insufficient — the caller
 * must pass whether a stop was requested.
 */
export type TerminationClass =
	| { kind: "requested"; reason: "user_abort" | "sigterm" }
	| { kind: "crashed"; reason: "abort" | "sigterm" }
	| { kind: "error" };

export function classifyRunnerTermination(
	error: Error,
	stopRequested: boolean,
): TerminationClass {
	const isAbortError =
		error.name === "AbortError" || error.message.includes("aborted by user");
	const isSigterm = error.message.includes(
		"Claude Code process exited with code 143",
	);
	if (isAbortError) {
		return stopRequested
			? { kind: "requested", reason: "user_abort" }
			: { kind: "crashed", reason: "abort" };
	}
	if (isSigterm) {
		return stopRequested
			? { kind: "requested", reason: "sigterm" }
			: { kind: "crashed", reason: "sigterm" };
	}
	return { kind: "error" };
}
