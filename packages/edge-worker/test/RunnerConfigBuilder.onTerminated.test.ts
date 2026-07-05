import type { CyrusAgentSession, ILogger, RepositoryConfig } from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
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

describe("RunnerConfigBuilder threads onTerminated to the runner config", () => {
	it("forwards onTerminated from input into the built config", async () => {
		const onTerminated = vi.fn();
		const { config } = await makeBuilder().buildIssueConfig({
			session: makeSession(),
			repository: makeRepository(),
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
			onTerminated, // <-- new field
			requireLinearWorkspaceId: () => "ws-1",
		});
		expect(config.onTerminated).toBe(onTerminated);
	});
});
