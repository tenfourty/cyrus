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

function makeSession(
	sessionOverrides: Partial<CyrusAgentSession> = {},
): CyrusAgentSession {
	return {
		issueId: "issue-1",
		issue: { identifier: "ABC-1" },
		workspace: { path: "/ws/repo-a", isGitWorktree: true },
		...sessionOverrides,
	} as unknown as CyrusAgentSession;
}

function buildIssueResult(
	repository: RepositoryConfig,
	selectorOverrides: Partial<IRunnerSelector> = {},
	sessionOverrides: Partial<CyrusAgentSession> = {},
) {
	return makeBuilder(selectorOverrides).buildIssueConfig({
		session: makeSession(sessionOverrides),
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
}

function buildFallbackModel(
	repository: RepositoryConfig,
	selectorOverrides: Partial<IRunnerSelector> = {},
) {
	const { config } = buildIssueResult(repository, selectorOverrides);
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

	// The runner selector ALWAYS derives a fallbackModelOverride from the model
	// (inferFallbackModel: sonnet→haiku, unknown→sonnet). That derived default
	// must NOT shadow fallback the user explicitly configured — otherwise a
	// configured chain never reaches the SDK. Explicit config wins.
	it("prefers an explicit per-repo chain over the model-inferred fallback", () => {
		expect(
			buildFallbackModel(makeRepository(["minimax", "haiku"]), {
				determineRunnerSelection: () => ({
					runnerType: "claude" as const,
					fallbackModelOverride: "haiku", // inferred from the model
				}),
			}),
		).toBe("minimax,haiku");
	});

	it("prefers an explicit global chain over the model-inferred fallback", () => {
		expect(
			buildFallbackModel(makeRepository(), {
				determineRunnerSelection: () => ({
					runnerType: "claude" as const,
					fallbackModelOverride: "haiku", // inferred from the model
				}),
				getConfiguredFallbackModelForRunner: () => ["glm-fallback", "minimax"],
			}),
		).toBe("glm-fallback,minimax");
	});

	it("per-repo config outranks a configured global chain", () => {
		expect(
			buildFallbackModel(makeRepository(["repo-a", "repo-b"]), {
				getConfiguredFallbackModelForRunner: () => ["global-a", "global-b"],
			}),
		).toBe("repo-a,repo-b");
	});

	it("uses the model-inferred fallback when nothing is configured", () => {
		expect(
			buildFallbackModel(makeRepository(), {
				determineRunnerSelection: () => ({
					runnerType: "claude" as const,
					fallbackModelOverride: "haiku",
				}),
				getConfiguredFallbackModelForRunner: () => undefined,
			}),
		).toBe("haiku");
	});

	// `repository.fallbackModel` has no runner scoping — unlike
	// getConfiguredFallbackModelForRunner, it doesn't know which runner it's
	// for. It must only be consulted when the resolved runner is Claude, or a
	// repo-configured Claude chain (e.g. "sonnet,haiku") leaks into a
	// Codex/Gemini/Cursor session as a single literal (invalid) model id.
	it("does NOT leak a repo Claude fallback chain into a Codex session", () => {
		const { config, runnerType } = buildIssueResult(
			makeRepository(["sonnet", "haiku"]),
			{
				determineRunnerSelection: () => ({
					runnerType: "codex" as const,
					fallbackModelOverride: "gpt-5.4",
				}),
				getDefaultFallbackModelForRunner: (runner) =>
					runner === "codex" ? "gpt-5.4" : "sonnet",
			},
		);
		expect(runnerType).toBe("codex");
		expect(config.fallbackModel).toBe("gpt-5.4");
	});

	it("does NOT leak a repo Claude fallback chain into a Gemini session", () => {
		const { config, runnerType } = buildIssueResult(
			makeRepository(["sonnet", "haiku"]),
			{
				determineRunnerSelection: () => ({
					runnerType: "gemini" as const,
					fallbackModelOverride: "gemini-2.5-flash",
				}),
				getDefaultFallbackModelForRunner: (runner) =>
					runner === "gemini" ? "gemini-2.5-flash" : "sonnet",
			},
		);
		expect(runnerType).toBe("gemini");
		expect(config.fallbackModel).toBe("gemini-2.5-flash");
	});

	// Resumed-session runner pinning (buildIssueConfig forces the runner back
	// to whichever one the session was actually started with, even if
	// determineRunnerSelection would otherwise pick a different one). A repo
	// Claude fallback chain must not defeat that pin by supplying a
	// Claude-shaped value for the pinned non-Claude runner.
	it("resumed-session runner pinning still wins over a repo Claude fallback chain", () => {
		const { config, runnerType } = buildIssueResult(
			makeRepository(["sonnet", "haiku"]),
			{
				// Labels/description now resolve to "claude" (e.g. the codex label
				// was removed), but the session already has a live codex session.
				determineRunnerSelection: () => ({ runnerType: "claude" as const }),
				getDefaultModelForRunner: (runner) =>
					runner === "codex" ? "gpt-5.5" : "opus",
				getDefaultFallbackModelForRunner: (runner) =>
					runner === "codex" ? "gpt-5.4" : "sonnet",
			},
			{ codexSessionId: "codex-session-1" },
		);
		expect(runnerType).toBe("codex");
		expect(config.fallbackModel).toBe("gpt-5.4");
	});
});
