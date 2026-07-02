import type { EdgeWorkerConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { RunnerSelectionService } from "../src/RunnerSelectionService.js";

function serviceWith(
	config: Partial<EdgeWorkerConfig>,
): RunnerSelectionService {
	return new RunnerSelectionService(config as EdgeWorkerConfig);
}

describe("RunnerSelectionService.getDefaultFallbackModelForRunner (claude)", () => {
	it("collapses a global fallback chain into the comma form", () => {
		const service = serviceWith({
			claudeDefaultFallbackModel: ["minimax", "haiku"],
		});
		expect(service.getDefaultFallbackModelForRunner("claude")).toBe(
			"minimax,haiku",
		);
	});

	it("passes a single global fallback string through (back-compat)", () => {
		const service = serviceWith({ claudeDefaultFallbackModel: "minimax" });
		expect(service.getDefaultFallbackModelForRunner("claude")).toBe("minimax");
	});

	it("honors the deprecated defaultFallbackModel chain when the new key is unset", () => {
		const service = serviceWith({ defaultFallbackModel: ["a", "b"] });
		expect(service.getDefaultFallbackModelForRunner("claude")).toBe("a,b");
	});

	it("defaults to sonnet when nothing is configured", () => {
		expect(serviceWith({}).getDefaultFallbackModelForRunner("claude")).toBe(
			"sonnet",
		);
	});

	it("ignores an empty-array global and falls back to sonnet", () => {
		const service = serviceWith({ claudeDefaultFallbackModel: [] });
		expect(service.getDefaultFallbackModelForRunner("claude")).toBe("sonnet");
	});
});
