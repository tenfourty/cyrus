/**
 * Build the user-facing "session stopped" message posted to Linear when an
 * issue reaches a terminal state. The Linear `issueStatusChanged` notification
 * does not carry the new state type, so the caller fetches the issue's current
 * workflow state and passes its `type` here. Unknown / missing state types
 * (e.g. when the issue was hard-deleted and can no longer be fetched) fall
 * back to a neutral "was closed." wording.
 */
export function formatTerminalStopMessage(
	identifier: string,
	stateType: string | null | undefined,
): string {
	if (stateType === "completed") {
		return `Session stopped — ${identifier} was marked Done.`;
	}
	if (stateType === "canceled") {
		return `Session stopped — ${identifier} was Canceled.`;
	}
	return `Session stopped — ${identifier} was closed.`;
}
