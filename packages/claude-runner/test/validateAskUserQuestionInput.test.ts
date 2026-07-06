import { describe, expect, it } from "vitest";
import { validateAskUserQuestionInput } from "../src/validateAskUserQuestionInput.js";

function question(overrides: Partial<{ question: string }> = {}) {
	return {
		question: overrides.question ?? "Which database should we use?",
		header: "DB",
		options: [
			{ label: "Postgres", description: "Use Postgres" },
			{ label: "MySQL", description: "Use MySQL" },
		],
		multiSelect: false,
	};
}

describe("validateAskUserQuestionInput", () => {
	it("rejects an input with no 'questions' field", () => {
		expect(validateAskUserQuestionInput({})).toEqual({
			ok: false,
			message: "Invalid AskUserQuestion input: 'questions' array is required",
		});
	});

	it("rejects an input where 'questions' is not an array", () => {
		expect(validateAskUserQuestionInput({ questions: "x" })).toEqual({
			ok: false,
			message: "Invalid AskUserQuestion input: 'questions' array is required",
		});
	});

	it("rejects an input where 'questions' is undefined", () => {
		expect(validateAskUserQuestionInput({ questions: undefined })).toEqual({
			ok: false,
			message: "Invalid AskUserQuestion input: 'questions' array is required",
		});
	});

	it("rejects an empty 'questions' array (0 questions) as 'one at a time'", () => {
		expect(validateAskUserQuestionInput({ questions: [] })).toEqual({
			ok: false,
			message:
				"Only one question at a time is supported. Please ask each question separately.",
		});
	});

	it("rejects a 'questions' array with 2 entries", () => {
		expect(
			validateAskUserQuestionInput({ questions: [question(), question()] }),
		).toEqual({
			ok: false,
			message:
				"Only one question at a time is supported. Please ask each question separately.",
		});
	});

	it("rejects a 'questions' array with 3 entries", () => {
		expect(
			validateAskUserQuestionInput({
				questions: [question(), question(), question()],
			}),
		).toEqual({
			ok: false,
			message:
				"Only one question at a time is supported. Please ask each question separately.",
		});
	});

	it("rejects a 'questions' array with 4 entries", () => {
		expect(
			validateAskUserQuestionInput({
				questions: [question(), question(), question(), question()],
			}),
		).toEqual({
			ok: false,
			message:
				"Only one question at a time is supported. Please ask each question separately.",
		});
	});

	it("accepts a 'questions' array with exactly 1 entry", () => {
		expect(validateAskUserQuestionInput({ questions: [question()] })).toEqual({
			ok: true,
		});
	});
});
