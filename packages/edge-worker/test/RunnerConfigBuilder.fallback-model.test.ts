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

function buildFallbackModel(
	repository: RepositoryConfig,
	selectorOverrides: Partial<IRunnerSelector> = {},
) {
	const { config } = makeBuilder(selectorOverrides).buildIssueConfig({
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
	it("passes a per-repo fallback chain through as the comma-joined form", () => {
		expect(buildFallbackModel(makeRepository(["minimax", "haiku"]))).toBe(
			"minimax,haiku",
		);
	});

	it("passes a single per-repo fallback string through unchanged (back-compat)", () => {
		expect(buildFallbackModel(makeRepository("minimax"))).toBe("minimax");
	});

	it("uses the runner default when the repo has no fallback configured", () => {
		expect(buildFallbackModel(makeRepository())).toBe("sonnet");
	});

	it("falls through an empty per-repo array to the runner default (not '')", () => {
		// [] is truthy in JS — a naive `repo.fallbackModel || default` would
		// wrongly short-circuit on it and drop the configured default.
		expect(buildFallbackModel(makeRepository([]))).toBe("sonnet");
	});

	it("prefers a selector/label override chain over the per-repo config", () => {
		expect(
			buildFallbackModel(makeRepository(["minimax", "haiku"]), {
				determineRunnerSelection: () => ({
					runnerType: "claude" as const,
					fallbackModelOverride: "opus",
				}),
			}),
		).toBe("opus");
	});
});
