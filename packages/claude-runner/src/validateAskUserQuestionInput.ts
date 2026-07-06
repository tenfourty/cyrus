/**
 * Result of validating an `AskUserQuestion` tool input.
 */
export type AskUserQuestionValidation =
	| { ok: true }
	| { ok: false; message: string };

/**
 * Validate an AskUserQuestion tool input: the `questions` field must be an
 * array of exactly one question.
 *
 * Mirrors the two deny checks that used to live inline in
 * `ClaudeRunner.createCanUseToolCallback`. The deny messages are
 * byte-identical to the originals — callers (and Linear activity text)
 * depend on the exact wording.
 */
export function validateAskUserQuestionInput(
	input: unknown,
): AskUserQuestionValidation {
	const questions = (input as { questions?: unknown } | null | undefined)
		?.questions;

	if (!questions || !Array.isArray(questions)) {
		return {
			ok: false,
			message: "Invalid AskUserQuestion input: 'questions' array is required",
		};
	}

	// IMPORTANT: Only allow one question at a time
	if (questions.length !== 1) {
		return {
			ok: false,
			message:
				"Only one question at a time is supported. Please ask each question separately.",
		};
	}

	return { ok: true };
}
