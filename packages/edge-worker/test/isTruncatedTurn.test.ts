import { describe, expect, it } from "vitest";
import { isTruncatedTurn } from "../src/isTruncatedTurn.js";

describe("isTruncatedTurn", () => {
	it("true when assistant error is max_output_tokens (authoritative)", () => {
		expect(
			isTruncatedTurn({
				resultMessage: { subtype: "success", is_error: false },
				assistantError: "max_output_tokens",
			}),
		).toBe(true);
	});
	it("true via stop_reason soft fallback when no assistant error", () => {
		expect(
			isTruncatedTurn({
				resultMessage: {
					subtype: "success",
					is_error: false,
					stop_reason: "max_tokens",
				},
			}),
		).toBe(true);
	});
	it("false for a clean success", () => {
		expect(
			isTruncatedTurn({
				resultMessage: {
					subtype: "success",
					is_error: false,
					stop_reason: "end_turn",
				},
				assistantError: null,
			}),
		).toBe(false);
	});
	it("false for an is_error result (that is an Error, not a truncation)", () => {
		expect(
			isTruncatedTurn({
				resultMessage: { subtype: "success", is_error: true },
				assistantError: undefined,
			}),
		).toBe(false);
	});
	it("false for an error subtype", () => {
		expect(
			isTruncatedTurn({
				resultMessage: { subtype: "error_during_execution", is_error: true },
			}),
		).toBe(false);
	});
});
