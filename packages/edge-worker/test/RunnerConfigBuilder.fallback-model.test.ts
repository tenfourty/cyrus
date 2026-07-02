import type { CyrusAgentSession, ILogger, RepositoryConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	type IChatToolResolver,
	type IMcpConfigProvider,
	type IRunnerSelector,
	RunnerConfigBuilder,
} from "../src/RunnerConfigBuilder.js";

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

function makeBuilder(
	selectorOverrides: Partial<IRunnerSelector> = {},
): RunnerConfigBuilder {
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => ["Read(**)"],
	};
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => ({ runnerType: "claude" as const }),
		getDefaultModelForRunner: () => "opus",
		getDefaultFallbackModelForRunner: () => "sonnet",
		getConfiguredFallbackModelForRunner: () => undefined,
		...selectorOverrides,
	};
	return new RunnerConfigBuilder(
		chatToolResolver,
		mcpConfigProvider,
		runnerSelector,
	);
}

function makeRepository(
	fallbackModel?: RepositoryConfig["fallbackModel"],
): RepositoryConfig {
	return {
		id: "repo-a",
		name: "Repo A",
		repositoryPath: "/repos/repo-a",
		allowedTools: [],
		...(fallbackModel !== undefined ? { fallbackModel } : {}),
	} as unknown as RepositoryConfig;
}

function makeSession(): CyrusAgentSession {
	return {
		issueId: "issue-1",
		issue: { identifier: "ABC-1" },
		workspace: { path: "/ws/repo-a", isGitWorktree: true },
	} as unknown as CyrusAgentSession;
}

async function buildFallbackModel(
	repository: RepositoryConfig,
	selectorOverrides: Partial<IRunnerSelector> = {},
) {
	const { config } = await makeBuilder(selectorOverrides).buildIssueConfig({
		session: makeSession(),
		repository,
		sessionId: "sess-1",
		systemPrompt: "test",
		allowedTools: ["Read(**)"],
		allowedDirectories: ["/repos/repo-a"],
		disallowedTools: [],
		cyrusHome: "/tmp/cyrus-home",
		linearWorkspaceId: "ws-1",
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
	});
	return config.fallbackModel;
}

describe("RunnerConfigBuilder fallbackModel resolution", () => {
	it("passes a per-repo fallback chain through as the comma-joined form", async () => {
		expect(await buildFallbackModel(makeRepository(["minimax", "haiku"]))).toBe(
			"minimax,haiku",
		);
	});

	it("passes a single per-repo fallback string through unchanged (back-compat)", async () => {
		expect(await buildFallbackModel(makeRepository("minimax"))).toBe("minimax");
	});

	it("uses the runner default when the repo has no fallback configured", async () => {
		expect(await buildFallbackModel(makeRepository())).toBe("sonnet");
	});

	it("falls through an empty per-repo array to the runner default (not '')", async () => {
		// [] is truthy in JS — a naive `repo.fallbackModel || default` would
		// wrongly short-circuit on it and drop the configured default.
		expect(await buildFallbackModel(makeRepository([]))).toBe("sonnet");
	});

	// The runner selector ALWAYS derives a fallbackModelOverride from the model
	// (inferFallbackModel: sonnet→haiku, unknown→sonnet). That derived default
	// must NOT shadow fallback the user explicitly configured — otherwise a
	// configured chain never reaches the SDK. Explicit config wins.
	it("prefers an explicit per-repo chain over the model-inferred fallback", async () => {
		expect(
			await buildFallbackModel(makeRepository(["minimax", "haiku"]), {
				determineRunnerSelection: () => ({
					runnerType: "claude" as const,
					fallbackModelOverride: "haiku", // inferred from the model
				}),
			}),
		).toBe("minimax,haiku");
	});

	it("prefers an explicit global chain over the model-inferred fallback", async () => {
		expect(
			await buildFallbackModel(makeRepository(), {
				determineRunnerSelection: () => ({
					runnerType: "claude" as const,
					fallbackModelOverride: "haiku", // inferred from the model
				}),
				getConfiguredFallbackModelForRunner: () => ["glm-fallback", "minimax"],
			}),
		).toBe("glm-fallback,minimax");
	});

	it("per-repo config outranks a configured global chain", async () => {
		expect(
			await buildFallbackModel(makeRepository(["repo-a", "repo-b"]), {
				getConfiguredFallbackModelForRunner: () => ["global-a", "global-b"],
			}),
		).toBe("repo-a,repo-b");
	});

	it("uses the model-inferred fallback when nothing is configured", async () => {
		expect(
			await buildFallbackModel(makeRepository(), {
				determineRunnerSelection: () => ({
					runnerType: "claude" as const,
					fallbackModelOverride: "haiku",
				}),
				getConfiguredFallbackModelForRunner: () => undefined,
			}),
		).toBe("haiku");
	});
});
