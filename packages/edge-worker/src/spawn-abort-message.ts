import type { ILogger } from "cyrus-core";
import type { SpawnAbortReason } from "./shouldAbortSpawn.js";

interface ActivityPoster {
	createResponseActivity(sessionId: string, body: string): Promise<void>;
}

export interface NotifySpawnAbortInput {
	sessionId: string;
	reason: SpawnAbortReason;
	activityPoster: ActivityPoster;
	logger: ILogger;
}

/**
 * Post the user-facing spawn-abort message to the issue tracker. Best-effort:
 * the abort already happened upstream of this call, so a failed notification
 * is logged but never propagated — letting it throw would lose the abort's
 * side effects (persisted status flip, savePersistedState).
 *
 * Extracted from the EdgeWorker abort callsites so the seam can be unit
 * tested without mocking EdgeWorker construction.
 */
export async function notifySpawnAbort(
	input: NotifySpawnAbortInput,
): Promise<void> {
	const { sessionId, reason, activityPoster, logger } = input;
	try {
		await activityPoster.createResponseActivity(
			sessionId,
			formatSpawnAbortMessage(reason),
		);
	} catch (error) {
		logger.warn(
			`Failed to post spawn-abort notification for session ${sessionId} (reason=${reason}): ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

/**
 * Map a `shouldAbortSpawn` reason to a user-facing message suitable for
 * posting to the issue tracker (Linear thought/response activity, GitLab MR
 * note, etc.).
 *
 * Without these messages, when `shouldAbortSpawn` returns non-null Cyrus
 * silently drops the user's prompt — the user sees their comment land in
 * the tracker but never gets a response, eyes reaction, or error. The only
 * record of why is the `Aborting runner spawn: ...` log line in journalctl,
 * which only operators with shell access can see.
 *
 * Wording is deliberately actionable: each message tells the user what
 * happened in one sentence and what to do next (resend, re-open, create
 * new issue). The ⚠️ prefix matches existing operator-facing activity
 * prefixes (see `formatTerminalStopMessage`).
 */
export function formatSpawnAbortMessage(reason: SpawnAbortReason): string {
	switch (reason) {
		case "session-removed":
			return "⚠️ Your message arrived after this session was closed (the issue moved to a terminal state). Re-open the issue or create a new one to continue.";
		case "stop-requested":
			return "⚠️ A pending stop request was honored before this prompt could start a new runner. Please resend your message to start a fresh turn.";
		case "draining":
			return "⚠️ Cyrus is restarting and your message arrived during the shutdown window. Please resend in ~30 seconds.";
		case "worktree-missing":
			return "⚠️ The workspace for this session is no longer on disk and was not recreated for this prompt. Please resend your message — the next prompt will recreate the workspace cleanly.";
	}
}
