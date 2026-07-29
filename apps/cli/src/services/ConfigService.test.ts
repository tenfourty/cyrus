import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
}));

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { EdgeConfig } from "../config/types.js";
import { ConfigService } from "./ConfigService.js";
import type { Logger } from "./Logger.js";

const silentLogger: Logger = {
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
} as unknown as Logger;

describe("ConfigService legacy defaultFallbackModel migration", () => {
	beforeEach(() => {
		vi.mocked(existsSync).mockReset().mockReturnValue(true);
		vi.mocked(mkdirSync).mockReset();
		vi.mocked(readFileSync).mockReset();
		vi.mocked(writeFileSync).mockReset();
	});

	function loadWith(raw: Record<string, unknown>): EdgeConfig {
		vi.mocked(readFileSync).mockReturnValue(JSON.stringify(raw));
		const service = new ConfigService("/tmp/cyrus-home", silentLogger);
		return service.load();
	}

	it("migrates a legacy defaultFallbackModel string when the new key is unset", () => {
		const config = loadWith({
			repositories: [],
			defaultFallbackModel: "sonnet",
		});
		expect(config.claudeDefaultFallbackModel).toBe("sonnet");
		expect(config.defaultFallbackModel).toBeUndefined();
	});

	// Regression test: `[]` is truthy in JS. A naive
	// `if (!config.claudeDefaultFallbackModel)` guard treats an
	// already-present-but-empty array as "already configured", skips copying
	// the legacy value across, and then the unconditional `delete` destroys
	// the operator's real legacy config with nothing left to replace it —
	// silent data loss on every load of an old config file.
	it("does NOT destroy a legacy defaultFallbackModel when claudeDefaultFallbackModel is an empty array", () => {
		const config = loadWith({
			repositories: [],
			claudeDefaultFallbackModel: [],
			defaultFallbackModel: ["minimax", "haiku"],
		});
		expect(config.claudeDefaultFallbackModel).toEqual(["minimax", "haiku"]);
		expect(config.defaultFallbackModel).toBeUndefined();
	});

	it("preserves an already-configured claudeDefaultFallbackModel over the legacy value", () => {
		const config = loadWith({
			repositories: [],
			claudeDefaultFallbackModel: "haiku",
			defaultFallbackModel: "minimax",
		});
		expect(config.claudeDefaultFallbackModel).toBe("haiku");
		expect(config.defaultFallbackModel).toBeUndefined();
	});

	it("leaves claudeDefaultFallbackModel untouched when no legacy key is present", () => {
		const config = loadWith({
			repositories: [],
			claudeDefaultFallbackModel: ["sonnet", "haiku"],
		});
		expect(config.claudeDefaultFallbackModel).toEqual(["sonnet", "haiku"]);
	});
});
