import { readFile } from "node:fs/promises";
import type { EdgeWorkerConfig, ILogger } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "../src/ConfigManager.js";

vi.mock("node:fs/promises");

/**
 * Ensure the top-level `telemetry` config block participates in the config
 * hot-reload pipeline — both the merge in `loadConfigSafely()` and the
 * global-change detection in `detectGlobalConfigChanges()`. Without these,
 * a `telemetry` change written to config.json while Cyrus is running would
 * be silently dropped (see CLAUDE.md note #9 — this is the same class of
 * bug as the prReviewTrigger/autoCompactThresholdPercent gotchas).
 */
describe("ConfigManager - telemetry hot-reload", () => {
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

	it("merges telemetry:{enabled:true} from the reloaded config file", async () => {
		const manager = makeManager(baseConfig);
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({
				repositories: baseConfig.repositories,
				telemetry: { enabled: true },
			}) as any,
		);

		const newConfig = await (manager as any).loadConfigSafely();

		expect(newConfig).not.toBeNull();
		expect(newConfig.telemetry).toEqual({ enabled: true });
	});

	it("detects a telemetry change as a global config change", () => {
		const manager = makeManager(baseConfig);

		const changed = (manager as any).detectGlobalConfigChanges({
			...baseConfig,
			telemetry: { enabled: true },
		});

		expect(changed).toBe(true);
	});

	it("preserves an existing telemetry value when the file omits it", async () => {
		const manager = makeManager({
			...baseConfig,
			telemetry: { enabled: true },
		});
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({ repositories: baseConfig.repositories }) as any,
		);

		const newConfig = await (manager as any).loadConfigSafely();

		expect(newConfig.telemetry).toEqual({ enabled: true });
	});
});
