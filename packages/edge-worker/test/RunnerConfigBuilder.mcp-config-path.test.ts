import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "cyrus-claude-runner";
import type { CyrusAgentSession, ILogger, RepositoryConfig } from "cyrus-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type IChatToolResolver,
	type IMcpConfigProvider,
	type IRunnerSelector,
	RunnerConfigBuilder,
	readMcpServerNamesFromPaths,
} from "../src/RunnerConfigBuilder.js";

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

// Temp `.mcp.json` fixtures written once for the whole suite.
let tmp: string;
let twoServersPath: string;
let overlapPath: string;
let myServerPath: string;
let slackCollisionPath: string;
let malformedPath: string;
let noServersPath: string;
let nonObjectServersPath: string;
let missingPath: string;

beforeAll(() => {
	tmp = mkdtempSync(join(tmpdir(), "rcb-mcp-"));

	twoServersPath = join(tmp, "two-servers.mcp.json");
	writeFileSync(
		twoServersPath,
		JSON.stringify({
			mcpServers: {
				"server-one": { command: "x" },
				"server-two": { command: "y" },
			},
		}),
	);

	overlapPath = join(tmp, "overlap.mcp.json");
	writeFileSync(
		overlapPath,
		JSON.stringify({
			mcpServers: {
				"server-two": { command: "y" },
				"server-three": { command: "z" },
			},
		}),
	);

	myServerPath = join(tmp, "my-server.mcp.json");
	writeFileSync(
		myServerPath,
		JSON.stringify({
			mcpServers: { "my-server": { command: "node", args: ["s.js"] } },
		}),
	);

	slackCollisionPath = join(tmp, "slack-collision.mcp.json");
	writeFileSync(
		slackCollisionPath,
		JSON.stringify({ mcpServers: { slack: { command: "node" } } }),
	);

	malformedPath = join(tmp, "malformed.mcp.json");
	writeFileSync(malformedPath, "{ not valid json ");

	noServersPath = join(tmp, "no-servers.mcp.json");
	writeFileSync(noServersPath, JSON.stringify({ foo: "bar" }));

	nonObjectServersPath = join(tmp, "non-object-servers.mcp.json");
	writeFileSync(nonObjectServersPath, JSON.stringify({ mcpServers: "nope" }));

	missingPath = join(tmp, "does-not-exist.mcp.json");
});

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("readMcpServerNamesFromPaths", () => {
	it("returns [] for undefined input", () => {
		expect(readMcpServerNamesFromPaths(undefined)).toEqual([]);
	});

	it("returns the mcpServers keys from a single .mcp.json path", () => {
		expect(readMcpServerNamesFromPaths(twoServersPath).sort()).toEqual([
			"server-one",
			"server-two",
		]);
	});

	it("returns the deduplicated union across an array of paths", () => {
		const names = readMcpServerNamesFromPaths([twoServersPath, overlapPath]);
		expect(names.sort()).toEqual(["server-one", "server-three", "server-two"]);
		expect(names.length).toBe(3);
	});

	it("returns [] for a missing file without throwing", () => {
		expect(readMcpServerNamesFromPaths(missingPath, silentLogger)).toEqual([]);
	});

	it("returns [] for malformed JSON without throwing", () => {
		expect(readMcpServerNamesFromPaths(malformedPath, silentLogger)).toEqual(
			[],
		);
	});

	it("returns [] when mcpServers is absent", () => {
		expect(readMcpServerNamesFromPaths(noServersPath)).toEqual([]);
	});

	it("returns [] when mcpServers is not an object", () => {
		expect(readMcpServerNamesFromPaths(nonObjectServersPath)).toEqual([]);
	});
});

function inlineConfig(keys: string[]): Record<string, McpServerConfig> {
	const out: Record<string, McpServerConfig> = {};
	for (const k of keys) out[k] = {} as unknown as McpServerConfig;
	return out;
}

function makeChatBuilder(inlineKeys: string[]): {
	builder: RunnerConfigBuilder;
	captured: { mcpConfigKeys?: string[] };
} {
	const captured: { mcpConfigKeys?: string[] } = {};
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: (mcpConfigKeys) => {
			captured.mcpConfigKeys = mcpConfigKeys;
			return (mcpConfigKeys ?? []).map((k) => `mcp__${k}`);
		},
	};
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => inlineConfig(inlineKeys),
		buildMergedMcpConfigPath: () => undefined,
	};
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => ({ runnerType: "claude" as const }),
		getDefaultModelForRunner: () => "opus",
		getDefaultFallbackModelForRunner: () => "sonnet",
	};
	return {
		builder: new RunnerConfigBuilder(
			chatToolResolver,
			mcpConfigProvider,
			runnerSelector,
		),
		captured,
	};
}

function baseChatInput() {
	return {
		workspacePath: "/ws/thread",
		workspaceName: "thread",
		systemPrompt: "test",
		sessionId: "sess-1",
		cyrusHome: "/tmp/cyrus-home",
		platformName: "slack",
		linearWorkspaceId: "ws-1",
		repository: makeRepository([]),
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
	};
}

describe("RunnerConfigBuilder.buildChatConfig — mcpConfigPath allowedTools", () => {
	it("surfaces .mcp.json server names into the chat tool resolver alongside inline keys", () => {
		const { builder, captured } = makeChatBuilder(["linear"]);
		builder.buildChatConfig({
			...baseChatInput(),
			platformMcpConfigOverrides: [myServerPath],
		});
		expect(captured.mcpConfigKeys).toBeDefined();
		expect([...(captured.mcpConfigKeys ?? [])].sort()).toEqual([
			"linear",
			"my-server",
		]);
	});

	it("passes only inline keys when no .mcp.json override is present (regression)", () => {
		const { builder, captured } = makeChatBuilder(["linear"]);
		builder.buildChatConfig(baseChatInput());
		expect(captured.mcpConfigKeys).toEqual(["linear"]);
	});

	it("does not duplicate a server name present both inline and in a .mcp.json file", () => {
		const { builder, captured } = makeChatBuilder(["slack"]);
		builder.buildChatConfig({
			...baseChatInput(),
			platformMcpConfigOverrides: [slackCollisionPath],
		});
		expect(captured.mcpConfigKeys).toEqual(["slack"]);
	});
});

function makeBuilder(): RunnerConfigBuilder {
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
	};
	return new RunnerConfigBuilder(
		chatToolResolver,
		mcpConfigProvider,
		runnerSelector,
	);
}

function makeRepository(allowedTools: string[]): RepositoryConfig {
	return {
		id: "repo-a",
		name: "Repo A",
		repositoryPath: "/repos/repo-a",
		allowedTools,
	} as unknown as RepositoryConfig;
}

function makeSession(): CyrusAgentSession {
	return {
		issueId: "issue-1",
		issue: { identifier: "ABC-1" },
		workspace: { path: "/ws/repo", isGitWorktree: true },
	} as unknown as CyrusAgentSession;
}

function runIssue(opts: {
	allowedTools: string[];
	platformMcpConfigOverrides?: readonly string[];
	repoAllowedTools?: string[];
}) {
	return makeBuilder().buildIssueConfig({
		session: makeSession(),
		repository: makeRepository(opts.repoAllowedTools ?? []),
		sessionId: "sess-1",
		systemPrompt: "test",
		allowedTools: opts.allowedTools,
		allowedDirectories: ["/ws/repo"],
		disallowedTools: [],
		cyrusHome: "/tmp/cyrus-home",
		linearWorkspaceId: "ws-1",
		platformMcpConfigOverrides: opts.platformMcpConfigOverrides,
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
	});
}

describe("RunnerConfigBuilder.buildIssueConfig — mcpConfigPath allowedTools", () => {
	it("augments allowedTools with mcp__<name> for .mcp.json servers", () => {
		const { config } = runIssue({
			allowedTools: ["Read(**)"],
			platformMcpConfigOverrides: [myServerPath],
		});
		expect(config.allowedTools).toContain("Read(**)");
		expect(config.allowedTools).toContain("mcp__my-server");
	});

	it("leaves allowedTools unchanged when no mcpConfigPath is present (regression)", () => {
		const { config } = runIssue({ allowedTools: ["Read(**)"] });
		expect(config.allowedTools).toEqual(["Read(**)"]);
	});

	it("does not duplicate an mcp__<name> already present in allowedTools", () => {
		const { config } = runIssue({
			allowedTools: ["Read(**)", "mcp__my-server"],
			platformMcpConfigOverrides: [myServerPath],
		});
		const count = config.allowedTools.filter(
			(t) => t === "mcp__my-server",
		).length;
		expect(count).toBe(1);
	});
});
