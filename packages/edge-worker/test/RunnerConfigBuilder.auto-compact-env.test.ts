import type { ILogger } from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import {
	type IChatToolResolver,
	type IMcpConfigProvider,
	type IRunnerSelector,
	type IssueRunnerConfigInput,
	RunnerConfigBuilder,
} from "../src/RunnerConfigBuilder.js";

/**
 * Regression for the autoCompactThresholdPercent injection bug: the env
 * var injection that 728907c7 added lived inside `buildSandboxConfig`,
 * which is only invoked when `input.sandboxSettings` is set. On
 * sandbox-disabled installs (the default), the config field was inert —
 * `~/.cyrus/config.json: { "autoCompactThresholdPercent": 50 }` had no
 * effect on the spawned subprocess env, and CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
 * never reached the Claude session.
 *
 * The fix lifts the env-var injection out of the sandbox gate. These tests
 * assert the new behavior across both sandbox-enabled and sandbox-disabled
 * builds.
 */

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	event: () => {},
	withContext: function () {
		return this;
	},
	getLevel: () => 0,
	setLevel: () => {},
} as unknown as ILogger;

function makeBuilder(): RunnerConfigBuilder {
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => [],
	};
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => ({ runnerType: "claude" }),
		getDefaultModelForRunner: () => "opus",
		getDefaultFallbackModelForRunner: () => "sonnet",
	};
	return new RunnerConfigBuilder(
		chatToolResolver,
		mcpConfigProvider,
		runnerSelector,
	);
}

function makeBaseInput(
	overrides: Partial<IssueRunnerConfigInput> = {},
): IssueRunnerConfigInput {
	return {
		session: {
			id: "sess",
			issueId: "ISSUE-1",
			issue: { id: "ISSUE-1", identifier: "ISSUE-1" },
			workspace: { path: "/tmp/wt", isGitWorktree: true },
		} as any,
		repository: {
			id: "repo-1",
			name: "repo",
			repositoryPath: "/tmp/bare",
			baseBranch: "main",
			workspaceBaseDir: "/tmp/wt-base",
		} as any,
		sessionId: "sess",
		systemPrompt: undefined,
		allowedTools: [],
		allowedDirectories: [],
		disallowedTools: [],
		cyrusHome: "/tmp/cyrus-home",
		logger: silentLogger,
		onMessage: vi.fn(),
		onError: vi.fn(),
		requireLinearWorkspaceId: () => "ws-1",
		...overrides,
	};
}

describe("RunnerConfigBuilder auto-compact env injection", () => {
	it("injects CLAUDE_AUTOCOMPACT_PCT_OVERRIDE when threshold is set on a sandbox-DISABLED install", () => {
		const builder = makeBuilder();
		const result = builder.buildIssueConfig(
			makeBaseInput({
				autoCompactThresholdPercent: 50,
				sandboxSettings: undefined,
			}),
		);

		const env = (result.config as any).additionalEnv as
			| Record<string, string>
			| undefined;
		expect(env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("50");
	});

	it("injects CLAUDE_AUTOCOMPACT_PCT_OVERRIDE when threshold is set AND sandbox is enabled (coexists with egress CA cert vars)", () => {
		const builder = makeBuilder();
		const result = builder.buildIssueConfig(
			makeBaseInput({
				autoCompactThresholdPercent: 75,
				sandboxSettings: {
					enabled: true,
					filesystem: {},
				} as any,
				egressCaCertPath: "/etc/cyrus/ca.pem",
			}),
		);

		const env = (result.config as any).additionalEnv as
			| Record<string, string>
			| undefined;
		expect(env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("75");
		// Egress CA cert env vars stay attached when sandbox IS enabled.
		expect(env?.NODE_EXTRA_CA_CERTS).toBe("/etc/cyrus/ca.pem");
	});

	it("does not inject CLAUDE_AUTOCOMPACT_PCT_OVERRIDE when threshold is not configured", () => {
		const builder = makeBuilder();
		const result = builder.buildIssueConfig(
			makeBaseInput({
				autoCompactThresholdPercent: undefined,
				sandboxSettings: undefined,
			}),
		);

		const env = (result.config as any).additionalEnv as
			| Record<string, string>
			| undefined;
		expect(env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBeUndefined();
	});
});
