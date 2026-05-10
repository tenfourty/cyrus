import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CyrusAgentSession, ILogger, RepositoryConfig } from "cyrus-core";
import { getDefaultReposDir } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getIssueAutoMemoryDirectory,
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
	runnerType: "claude" | "codex" = "claude",
): RunnerConfigBuilder {
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => ["Read(**)"],
	};
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => ({ runnerType }),
		getDefaultModelForRunner: () => "opus",
		getDefaultFallbackModelForRunner: () => "sonnet",
	};
	return new RunnerConfigBuilder(
		chatToolResolver,
		mcpConfigProvider,
		runnerSelector,
	);
}

function makeRepository(
	overrides?: Partial<RepositoryConfig>,
): RepositoryConfig {
	return {
		id: "repo-a",
		name: "Repo A",
		repositoryPath: "/repos/repo-a",
		allowedTools: [],
		...overrides,
	} as unknown as RepositoryConfig;
}

function makeSession(): CyrusAgentSession {
	return {
		issueId: "issue-1",
		issue: { identifier: "CYPACK-1" },
		workspace: { path: "/ws/root", isGitWorktree: true },
	} as unknown as CyrusAgentSession;
}

describe("getIssueAutoMemoryDirectory", () => {
	it("derives <cyrusHome>/memory/<repository.id> — Cyrus picks the path, no encoding involved", () => {
		expect(getIssueAutoMemoryDirectory("/tmp/cyrus-home", "repo-a")).toBe(
			"/tmp/cyrus-home/memory/repo-a",
		);
	});

	it("scopes by repository id, not by repository path", () => {
		// Two repos with very different on-disk paths but the same id would be
		// unusual, but the point is the encoder never looks at the path at
		// all — renaming/moving a repo's checkout does not orphan its memory.
		expect(getIssueAutoMemoryDirectory("/tmp/cyrus-home", "repo-b")).toBe(
			"/tmp/cyrus-home/memory/repo-b",
		);
	});

	describe("namespace collision with the repository-clone directory", () => {
		const originalCyrusReposDir = process.env.CYRUS_REPOS_DIR;

		afterEach(() => {
			if (originalCyrusReposDir === undefined) {
				delete process.env.CYRUS_REPOS_DIR;
			} else {
				process.env.CYRUS_REPOS_DIR = originalCyrusReposDir;
			}
		});

		const repositoryIds = ["repo-a", "repo-b", "repo1", "my-repo"];

		it.each(
			repositoryIds,
		)("never places the memory dir for id %s under the default repos dir", (repositoryId) => {
			delete process.env.CYRUS_REPOS_DIR;
			const cyrusHome = "/tmp/cyrus-home";
			const memoryDir = getIssueAutoMemoryDirectory(cyrusHome, repositoryId);
			const reposDir = getDefaultReposDir(cyrusHome);
			expect(memoryDir.startsWith(`${reposDir}/`)).toBe(false);
			expect(memoryDir).not.toBe(reposDir);
		});

		it.each(
			repositoryIds,
		)("still avoids the repos dir for id %s when CYRUS_REPOS_DIR is overridden", (repositoryId) => {
			process.env.CYRUS_REPOS_DIR = "/somewhere/else/repos";
			const cyrusHome = "/tmp/cyrus-home";
			const memoryDir = getIssueAutoMemoryDirectory(cyrusHome, repositoryId);
			const reposDir = getDefaultReposDir(cyrusHome);
			expect(reposDir).toBe("/somewhere/else/repos");
			expect(memoryDir.startsWith(`${reposDir}/`)).toBe(false);
			expect(memoryDir).not.toBe(reposDir);
			// Still scoped under cyrusHome's own memory/ namespace, unaffected
			// by where repo clones happen to live.
			expect(memoryDir).toBe(`${cyrusHome}/memory/${repositoryId}`);
		});
	});

	describe("repository id validation", () => {
		it("throws for a parent-traversal id", () => {
			expect(() =>
				getIssueAutoMemoryDirectory("/tmp/cyrus-home", "../.."),
			).toThrow();
		});

		it('throws for the literal ".." segment', () => {
			expect(() =>
				getIssueAutoMemoryDirectory("/tmp/cyrus-home", ".."),
			).toThrow();
		});

		it('throws for the literal "." segment', () => {
			expect(() =>
				getIssueAutoMemoryDirectory("/tmp/cyrus-home", "."),
			).toThrow();
		});

		it("throws for an id containing a path separator", () => {
			expect(() =>
				getIssueAutoMemoryDirectory("/tmp/cyrus-home", "a/b"),
			).toThrow();
		});
	});
});

describe("RunnerConfigBuilder.buildIssueConfig auto-memory wiring", () => {
	function buildConfig(sandboxSettings?: Record<string, unknown>) {
		const { config } = makeBuilder("claude").buildIssueConfig({
			session: makeSession(),
			repository: makeRepository(),
			sessionId: "sess-1",
			systemPrompt: "test",
			allowedTools: ["Read(**)"],
			allowedDirectories: ["/ws/root", "/repos/repo-a"],
			disallowedTools: [],
			cyrusHome: "/tmp/cyrus-home",
			linearWorkspaceId: "ws-1",
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
			requireLinearWorkspaceId: () => "ws-1",
			...(sandboxSettings ? { sandboxSettings } : {}),
		});
		return config as {
			autoMemoryDirectory?: string;
			allowedDirectories?: string[];
			sandbox?: {
				filesystem?: { allowRead?: string[]; allowWrite?: string[] };
			};
		};
	}

	const expectedMemoryDir = "/tmp/cyrus-home/memory/repo-a";

	it("sets autoMemoryDirectory on the config so the runner tells the SDK to use it", () => {
		const config = buildConfig();
		expect(config.autoMemoryDirectory).toBe(expectedMemoryDir);
	});

	it("includes the auto-memory directory in allowedDirectories", () => {
		const config = buildConfig();
		expect(config.allowedDirectories).toEqual([
			"/ws/root",
			"/repos/repo-a",
			expectedMemoryDir,
		]);
	});

	it("does not duplicate the auto-memory directory if a caller already added it to allowedDirectories", () => {
		const { config } = makeBuilder("claude").buildIssueConfig({
			session: makeSession(),
			repository: makeRepository(),
			sessionId: "sess-1",
			systemPrompt: "test",
			allowedTools: ["Read(**)"],
			allowedDirectories: ["/ws/root", expectedMemoryDir],
			disallowedTools: [],
			cyrusHome: "/tmp/cyrus-home",
			linearWorkspaceId: "ws-1",
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
			requireLinearWorkspaceId: () => "ws-1",
		});
		const allowedDirectories = (config as { allowedDirectories?: string[] })
			.allowedDirectories;
		expect(
			allowedDirectories?.filter((p) => p === expectedMemoryDir),
		).toHaveLength(1);
	});

	it("plumbs the auto-memory directory into the OS-level sandbox's allowRead AND allowWrite, not just the tool-permission allowedDirectories", () => {
		// Regression test for the fault this redesign fixes: previously the
		// memory directory only reached `config.allowedDirectories` (the
		// Claude-Code-tool-permission layer). `buildSandboxConfig` built the
		// bubblewrap/seatbelt-level allow-lists from `input.allowedDirectories`
		// directly and `input.session.workspace.path` alone, so the memory dir
		// never reached the OS-level sandbox: reads of MEMORY.md would be
		// permitted by Claude Code but blocked by the sandbox, and writes to a
		// new entry file would be blocked outright (allowWrite included only
		// the worktree).
		const config = buildConfig({ enabled: true });

		expect(config.sandbox?.filesystem?.allowRead).toContain(expectedMemoryDir);
		expect(config.sandbox?.filesystem?.allowWrite).toContain(expectedMemoryDir);
		// The worktree must still be writable — the memory dir carve-out must
		// not have replaced it.
		expect(config.sandbox?.filesystem?.allowWrite).toContain("/ws/root");
	});

	it("leaves the sandbox unset when the egress sandbox is disabled", () => {
		expect(buildConfig(undefined).sandbox).toBeUndefined();
	});
});

describe("RunnerConfigBuilder.buildIssueConfig auto-memory directory creation", () => {
	let tempCyrusHome: string;

	beforeEach(() => {
		tempCyrusHome = mkdtempSync(join(tmpdir(), "cyrus-automemory-"));
	});

	afterEach(() => {
		rmSync(tempCyrusHome, { recursive: true, force: true });
	});

	function buildConfigWithCyrusHome(
		cyrusHome: string,
		sandboxSettings?: Record<string, unknown>,
	) {
		const { config } = makeBuilder("claude").buildIssueConfig({
			session: makeSession(),
			repository: makeRepository(),
			sessionId: "sess-1",
			systemPrompt: "test",
			allowedTools: ["Read(**)"],
			allowedDirectories: ["/ws/root", "/repos/repo-a"],
			disallowedTools: [],
			cyrusHome,
			linearWorkspaceId: "ws-1",
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
			requireLinearWorkspaceId: () => "ws-1",
			...(sandboxSettings ? { sandboxSettings } : {}),
		});
		return config as {
			autoMemoryDirectory?: string;
			allowedDirectories?: string[];
			sandbox?: {
				filesystem?: { allowRead?: string[]; allowWrite?: string[] };
			};
		};
	}

	it("actually creates the auto-memory directory on disk", () => {
		const config = buildConfigWithCyrusHome(tempCyrusHome);
		const expectedDir = join(tempCyrusHome, "memory", "repo-a");
		expect(config.autoMemoryDirectory).toBe(expectedDir);
		expect(existsSync(expectedDir)).toBe(true);
	});

	it("degrades gracefully when mkdir fails: no autoMemoryDirectory, no allowedDirectories entry, no sandbox grant", () => {
		// Force mkdirSync to throw ENOTDIR by pointing cyrusHome at a path
		// whose parent segment is a regular file, not a directory.
		const blockerFile = join(tempCyrusHome, "not-a-directory");
		writeFileSync(blockerFile, "blocking file");
		const brokenCyrusHome = join(blockerFile, "sub");

		const config = buildConfigWithCyrusHome(brokenCyrusHome, { enabled: true });

		expect(config.autoMemoryDirectory).toBeUndefined();
		expect(config.allowedDirectories).toEqual(["/ws/root", "/repos/repo-a"]);
		expect(config.allowedDirectories?.some((p) => p.includes("memory"))).toBe(
			false,
		);
		expect(config.sandbox?.filesystem?.allowRead ?? []).not.toContain(
			join(brokenCyrusHome, "memory", "repo-a"),
		);
		expect(config.sandbox?.filesystem?.allowWrite ?? []).not.toContain(
			join(brokenCyrusHome, "memory", "repo-a"),
		);
		// The worktree must still be writable even though auto-memory failed.
		expect(config.sandbox?.filesystem?.allowWrite).toContain("/ws/root");
	});

	it("degrades gracefully for an invalid repository id without crashing session startup", () => {
		const { config } = makeBuilder("claude").buildIssueConfig({
			session: makeSession(),
			repository: makeRepository({ id: "../.." }),
			sessionId: "sess-1",
			systemPrompt: "test",
			allowedTools: ["Read(**)"],
			allowedDirectories: ["/ws/root", "/repos/repo-a"],
			disallowedTools: [],
			cyrusHome: tempCyrusHome,
			linearWorkspaceId: "ws-1",
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
			requireLinearWorkspaceId: () => "ws-1",
			sandboxSettings: { enabled: true },
		});
		const typedConfig = config as {
			autoMemoryDirectory?: string;
			allowedDirectories?: string[];
			sandbox?: {
				filesystem?: { allowRead?: string[]; allowWrite?: string[] };
			};
		};

		expect(typedConfig.autoMemoryDirectory).toBeUndefined();
		expect(typedConfig.allowedDirectories).toEqual([
			"/ws/root",
			"/repos/repo-a",
		]);
		expect(
			typedConfig.sandbox?.filesystem?.allowRead?.some((p) =>
				p.includes("memory"),
			),
		).toBe(false);
		expect(
			typedConfig.sandbox?.filesystem?.allowWrite?.some((p) =>
				p.includes("memory"),
			),
		).toBe(false);
	});
});
