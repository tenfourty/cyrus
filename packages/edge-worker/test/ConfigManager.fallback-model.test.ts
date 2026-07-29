import { readFile } from "node:fs/promises";
import type { EdgeWorkerConfig, ILogger } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "../src/ConfigManager.js";

vi.mock("node:fs/promises");

/**
 * `claudeDefaultFallbackModel: []` is truthy in JS, so a plain `||` merge
 * chain (`parsedConfig.claudeDefaultFallbackModel ||
 * parsedConfig.defaultFallbackModel || ...`) stops at the empty array and
 * silently masks a legacy `defaultFallbackModel` the operator actually set —
 * on every hot-reload, not just once. `loadConfigSafely()` must treat an
 * empty array the same as unset.
 */
describe("ConfigManager - claudeDefaultFallbackModel hot-reload", () => {
	let logger: ILogger;

	const baseConfig: EdgeWorkerConfig = {
		proxyUrl: "http://localhost:3000",
		cyrusHome: "/tmp/cyrus-home",
		repositories: [
			{
				id: "repo-1",
				name: "Repo 1",
				repositoryPath: "/test/repo",
				baseBranch: "main",
				workspaceBaseDir: "/test/workspaces",
			},
		],
	} as unknown as EdgeWorkerConfig;

	function makeManager(config: EdgeWorkerConfig): ConfigManager {
		return new ConfigManager(
			config,
			logger,
			"/tmp/cyrus-home/config.json",
			new Map(config.repositories.map((r) => [r.id, r])),
		);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		logger = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		} as unknown as ILogger;
	});

	it("does not let an empty claudeDefaultFallbackModel mask a legacy defaultFallbackModel on disk", async () => {
		const manager = makeManager(baseConfig);
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({
				repositories: baseConfig.repositories,
				claudeDefaultFallbackModel: [],
				defaultFallbackModel: ["minimax", "haiku"],
			}) as any,
		);

		const newConfig = await (manager as any).loadConfigSafely();

		expect(newConfig).not.toBeNull();
		expect(newConfig.claudeDefaultFallbackModel).toEqual(["minimax", "haiku"]);
	});

	it("does not let an empty claudeDefaultFallbackModel mask the in-memory legacy value", async () => {
		const manager = makeManager({
			...baseConfig,
			defaultFallbackModel: "sonnet",
		});
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({
				repositories: baseConfig.repositories,
				claudeDefaultFallbackModel: [],
			}) as any,
		);

		const newConfig = await (manager as any).loadConfigSafely();

		expect(newConfig.claudeDefaultFallbackModel).toBe("sonnet");
	});

	it("still prefers an explicit, non-empty claudeDefaultFallbackModel from disk", async () => {
		const manager = makeManager(baseConfig);
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({
				repositories: baseConfig.repositories,
				claudeDefaultFallbackModel: "haiku",
				defaultFallbackModel: "minimax",
			}) as any,
		);

		const newConfig = await (manager as any).loadConfigSafely();

		expect(newConfig.claudeDefaultFallbackModel).toBe("haiku");
	});
});
