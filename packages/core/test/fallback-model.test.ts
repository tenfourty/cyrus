import { describe, expect, it } from "vitest";
import { normalizeFallbackModel } from "../src/fallback-model.js";

describe("normalizeFallbackModel", () => {
	it("returns undefined for undefined", () => {
		expect(normalizeFallbackModel(undefined)).toBeUndefined();
	});

	it("passes a single model string through unchanged", () => {
		expect(normalizeFallbackModel("sonnet")).toBe("sonnet");
	});

	it("trims a single model string", () => {
		expect(normalizeFallbackModel("  sonnet  ")).toBe("sonnet");
	});

	it("returns undefined for an empty / whitespace-only string", () => {
		expect(normalizeFallbackModel("")).toBeUndefined();
		expect(normalizeFallbackModel("   ")).toBeUndefined();
	});

	it("joins a chain into the comma-separated form the SDK/CLI expects", () => {
		expect(normalizeFallbackModel(["minimax", "haiku"])).toBe("minimax,haiku");
	});

	it("passes a single-element array through as that one model", () => {
		expect(normalizeFallbackModel(["a"])).toBe("a");
	});

	it("preserves order and joins three-plus entries", () => {
		expect(normalizeFallbackModel(["a", "b", "c"])).toBe("a,b,c");
	});

	it("returns undefined for an empty array (so `||` fallthrough still works)", () => {
		expect(normalizeFallbackModel([])).toBeUndefined();
	});

	it("drops empty / whitespace-only entries and trims the rest", () => {
		expect(normalizeFallbackModel(["  minimax ", "", "   ", "haiku"])).toBe(
			"minimax,haiku",
		);
	});

	it("returns undefined when every array entry is blank", () => {
		expect(normalizeFallbackModel(["", "  "])).toBeUndefined();
	});

	it("de-duplicates repeated models, preserving first-seen order", () => {
		expect(normalizeFallbackModel(["haiku", "sonnet", "haiku"])).toBe(
			"haiku,sonnet",
		);
	});

	// Env-var config (e.g. CYRUS_CLAUDE_DEFAULT_FALLBACK_MODEL) can only ever
	// be a scalar string, so a comma-separated string is the only way those
	// operators can express a chain. It must behave identically to the
	// equivalent array form: each segment trimmed, not just the whole string.
	it("splits a single comma-separated string into a trimmed chain, matching the array form", () => {
		expect(normalizeFallbackModel("minimax, haiku")).toBe("minimax,haiku");
		expect(normalizeFallbackModel("minimax, haiku")).toBe(
			normalizeFallbackModel(["minimax", "haiku"]),
		);
	});

	it("dedupes a comma-separated string the same way it dedupes an array", () => {
		expect(normalizeFallbackModel("haiku, sonnet, haiku")).toBe("haiku,sonnet");
	});
});
