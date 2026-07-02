import { describe, expect, it } from "vitest";
import { normalizeFallbackModel } from "./fallback-model.js";

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
});
