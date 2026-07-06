/**
 * Classifies why a ClaudeRunner's query loop threw, so the runner can tell a
 * Cyrus-initiated stop (via stop()) from an out-of-band death (crash / OOM /
 * external SIGTERM / stall-watchdog abort). A Cyrus stop() can surface as
 * EITHER an AbortError OR "exited with code 143", so error-shape alone is
 * insufficient — the caller must pass whether a stop was requested and
 * whether a stall watchdog fired.
 *
 * `stopRequested` is checked FIRST and wins over `stalled`: a user stop that
 * races a stale `stalled` flag (e.g. the watchdog armed just before the user
 * hit stop) must classify as `requested`, never as a crash/stall.
 */
export type TerminationClass =
	| { kind: "requested"; reason: "user_abort" | "sigterm" }
	| { kind: "crashed"; reason: "abort" | "sigterm" | "stall" }
	| { kind: "error" };

export function classifyRunnerTermination(
	error: Error,
	flags: { stopRequested: boolean; stalled: boolean },
): TerminationClass {
	const { stopRequested, stalled } = flags;
	const isAbortError =
		error.name === "AbortError" || error.message.includes("aborted by user");
	const isSigterm = error.message.includes(
		"Claude Code process exited with code 143",
	);
	if (isAbortError) {
		if (stopRequested) return { kind: "requested", reason: "user_abort" };
		if (stalled) return { kind: "crashed", reason: "stall" };
		return { kind: "crashed", reason: "abort" };
	}
	if (isSigterm) {
		if (stopRequested) return { kind: "requested", reason: "sigterm" };
		if (stalled) return { kind: "crashed", reason: "stall" };
		return { kind: "crashed", reason: "sigterm" };
	}
	return { kind: "error" };
}
