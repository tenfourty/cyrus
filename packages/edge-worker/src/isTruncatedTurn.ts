// assistantError = the last assistant message's SDK `error` field for this turn (may be undefined/null)
export function isTruncatedTurn(args: {
	resultMessage: {
		subtype?: string;
		is_error?: boolean;
		stop_reason?: string | null;
	};
	assistantError?: string | null;
}): boolean {
	const { resultMessage, assistantError } = args;
	const isNonErrorSuccess =
		resultMessage.subtype === "success" && !resultMessage.is_error;
	if (!isNonErrorSuccess) {
		return false;
	}
	return (
		assistantError === "max_output_tokens" ||
		resultMessage.stop_reason === "max_tokens"
	);
}
