import type { EdgeConfig, RepositoryConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { buildEdgeWorkerConfig } from "./buildEdgeWorkerConfig.js";

/**
 * Regression for the silent "hand-picked fields" bug: when WorkerService
 * built EdgeWorkerConfig by listing fields one-by-one off the loaded
 * EdgeConfig, any new top-level field added to EdgeConfigSchema was
 * inert until someone remembered to also wire it through the hand-picked
 * block. The autoCompactThresholdPercent field shipped 2026-05-12 was
 * the canonical example — config was loaded and validated, but never
 * reached EdgeWorker, so the downstream env injection and pre-turn
 * /compact guard both silently saw `undefined`.
 *
 * These tests pin the new pass-through behavior and lock in env-var
 * precedence for fields that still honor process.env overrides.
 */

const baseEdgeConfig: EdgeConfig = {
	repositories: [],
};

const repositories: RepositoryConfig[] = [
	{
		id: "r1",
		name: "r1",
		repositoryPath: "/tmp/r1",
		workspaceBaseDir: "/tmp/r1-ws",
		baseBranch: "main",
		linearWorkspaceId: "ws-1",
		linearWorkspaceName: "ws",
		linearToken: "tok",
		teamKeys: ["AAA"],
	} as RepositoryConfig,
];

describe("buildEdgeWorkerConfig", () => {
	it("passes top-level EdgeConfig fields through to EdgeWorkerConfig (regression for hand-picked-fields bug)", () => {
		const result = buildEdgeWorkerConfig({
			edgeConfig: {
				...baseEdgeConfig,
				autoCompactThresholdPercent: 50,
				autoResume: { enabled: true } as any,
				cursorDefaultModel: "composer-2",
			},
			env: {},
			repositories,
			cyrusHome: "/tmp/cyrus-home",
		});

		expect(result.autoCompactThresholdPercent).toBe(50);
		expect(result.autoResume).toEqual({ enabled: true });
		expect(result.cursorDefaultModel).toBe("composer-2");
	});

	it("overrides edgeConfig.repositories with explicit repositories param (runtime selection wins)", () => {
		const result = buildEdgeWorkerConfig({
			edgeConfig: {
				...baseEdgeConfig,
				repositories: [{ id: "stale" } as RepositoryConfig],
			},
			env: {},
			repositories,
			cyrusHome: "/tmp/cyrus-home",
		});

		expect(result.repositories).toBe(repositories);
	});

	it("honors CYRUS_CLAUDE_DEFAULT_MODEL over edgeConfig.claudeDefaultModel", () => {
		const result = buildEdgeWorkerConfig({
			edgeConfig: { ...baseEdgeConfig, claudeDefaultModel: "config-model" },
			env: { CYRUS_CLAUDE_DEFAULT_MODEL: "env-model" },
			repositories,
			cyrusHome: "/tmp/cyrus-home",
		});

		expect(result.claudeDefaultModel).toBe("env-model");
	});

	it("falls back to edgeConfig.defaultModel when no env var and no explicit claudeDefaultModel", () => {
		const result = buildEdgeWorkerConfig({
			edgeConfig: { ...baseEdgeConfig, defaultModel: "legacy" },
			env: {},
			repositories,
			cyrusHome: "/tmp/cyrus-home",
		});

		expect(result.claudeDefaultModel).toBe("legacy");
	});

	it("parses CYRUS_HOST_EXTERNAL truthy as 0.0.0.0 serverHost", () => {
		const result = buildEdgeWorkerConfig({
			edgeConfig: baseEdgeConfig,
			env: { CYRUS_HOST_EXTERNAL: "true" },
			repositories,
			cyrusHome: "/tmp/cyrus-home",
		});

		expect(result.serverHost).toBe("0.0.0.0");
	});

	it("defaults serverHost to localhost without CYRUS_HOST_EXTERNAL", () => {
		const result = buildEdgeWorkerConfig({
			edgeConfig: baseEdgeConfig,
			env: {},
			repositories,
			cyrusHome: "/tmp/cyrus-home",
		});

		expect(result.serverHost).toBe("localhost");
	});

	it("splits ALLOWED_TOOLS env into defaultAllowedTools array", () => {
		const result = buildEdgeWorkerConfig({
			edgeConfig: baseEdgeConfig,
			env: { ALLOWED_TOOLS: "Read, Write , Bash" },
			repositories,
			cyrusHome: "/tmp/cyrus-home",
		});

		expect(result.defaultAllowedTools).toEqual(["Read", "Write", "Bash"]);
	});

	it("threads cyrusHome and version through to runtime config", () => {
		const result = buildEdgeWorkerConfig({
			edgeConfig: baseEdgeConfig,
			env: {},
			repositories,
			cyrusHome: "/home/u/.cyrus",
			version: "1.2.3",
		});

		expect(result.cyrusHome).toBe("/home/u/.cyrus");
		expect(result.version).toBe("1.2.3");
	});
});
