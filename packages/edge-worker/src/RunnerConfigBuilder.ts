import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getClaudeProjectAutoMemoryDir,
	type HookCallbackMatcher,
	type HookEvent,
	type McpServerConfig,
	type PostToolUseHookInput,
	type SandboxSettings,
	type SDKMessage,
	type SdkPluginConfig,
	type StopHookInput,
} from "cyrus-claude-runner";
import type {
	AgentRunnerConfig,
	CyrusAgentSession,
	FallbackModelConfig,
	ILogger,
	OnAskUserQuestion,
	RepositoryConfig,
	RunnerType,
} from "cyrus-core";
import { normalizeFallbackModel } from "cyrus-core";
import { buildIntentToAddHook } from "./hooks/IntentToAddHook.js";
import { buildPrMarkerHook } from "./hooks/PrMarkerHook.js";
import { appendBrowserUseAddendum } from "./prompts/browserUsePromptAddendum.js";
import { appendCloudRuntimeAddendum } from "./prompts/cloudRuntimePromptAddendum.js";
import { appendFailureModeAddendum } from "./prompts/failureModePromptAddendum.js";
import { resolveSessionWorkingDirectory } from "./resolveSessionWorkingDirectory.js";

/**
 * Subset of McpConfigService consumed by RunnerConfigBuilder.
 */
export interface IMcpConfigProvider {
	buildMcpConfig(
		repoId: string,
		linearWorkspaceId: string,
		parentSessionId?: string,
		options?: { excludeSlackMcp?: boolean },
	): Promise<Record<string, McpServerConfig>>;
	buildMergedMcpConfigPath(
		repositories: RepositoryConfig | RepositoryConfig[],
	): string | string[] | undefined;
}

/**
 * Subset of ToolPermissionResolver consumed by RunnerConfigBuilder.
 */
export interface IChatToolResolver {
	buildChatAllowedTools(
		mcpConfigKeys?: string[],
		userMcpTools?: string[],
	): string[];
}

/**
 * Subset of RunnerSelectionService consumed by RunnerConfigBuilder.
 */
export interface IRunnerSelector {
	determineRunnerSelection(
		labels: string[],
		issueDescription?: string,
	): {
		runnerType: RunnerType;
		modelOverride?: string;
		fallbackModelOverride?: string;
	};
	getDefaultModelForRunner(runnerType: RunnerType): string;
	getDefaultFallbackModelForRunner(runnerType: RunnerType): string;
	/**
	 * The fallback the user *explicitly configured* for this runner (global
	 * scope), or undefined when unset. Distinct from
	 * getDefaultFallbackModelForRunner, which also bakes in the hardcoded
	 * per-runner default — this returns only what the operator set, so the
	 * builder can rank explicit config above the model-inferred fallback.
	 */
	getConfiguredFallbackModelForRunner?(
		runnerType: RunnerType,
	): FallbackModelConfig | undefined;
}

/**
 * Input for building a chat session runner config.
 */
export interface ChatRunnerConfigInput {
	workspacePath: string;
	workspaceName: string | undefined;
	systemPrompt: string;
	sessionId: string;
	resumeSessionId?: string;
	cyrusHome: string;
	/** Chat platform name (e.g. "slack") — used to namespace the shared auto-memory dir */
	platformName: string;
	/** Linear workspace ID for building fresh MCP config at session start */
	linearWorkspaceId?: string;
	/** Repository whose MCP runtime servers (Linear MCP, Cyrus tools, etc.) get
	 * spun up for this chat session — chat sessions are repo-agnostic at the
	 * session level, so this just picks one repo to seed those native servers. */
	repository?: RepositoryConfig;
	/** Repository paths the chat session can read */
	repositoryPaths?: string[];
	/**
	 * Filesystem paths to custom-integration `.mcp.json` files to load for
	 * this chat session (sourced from `EdgeWorkerConfig.slackMcpConfigs` for
	 * Slack). Chat sessions are repo-agnostic, so `repository.mcpConfigPath`
	 * is not consulted here — only this list determines which custom MCP
	 * files the session loads. When empty/omitted, no custom `.mcp.json`
	 * files are loaded (native servers built via `mcpConfigProvider` still
	 * run as usual).
	 */
	platformMcpConfigOverrides?: readonly string[];
	/** Plugins to load for the chat session (provides managed skills). */
	plugins?: SdkPluginConfig[];
	/**
	 * Allow-list of skill names enabled for the chat session after scope
	 * filtering. Claude passes this to the SDK directly; Codex stages only
	 * these skills into its repository discovery layout.
	 */
	skills?: string[] | "all";
	logger: ILogger;
	onMessage: (message: SDKMessage) => void | Promise<void>;
	onError: (error: Error) => void;
}

/**
 * Input for building an issue session runner config.
 */
export interface IssueRunnerConfigInput {
	session: CyrusAgentSession;
	repository: RepositoryConfig;
	sessionId: string;
	systemPrompt: string | undefined;
	allowedTools: string[];
	allowedDirectories: string[];
	disallowedTools: string[];
	resumeSessionId?: string;
	labels?: string[];
	issueDescription?: string;
	maxTurns?: number;
	/**
	 * Filesystem paths to custom-integration `.mcp.json` files for this
	 * issue session: `EdgeWorkerConfig.linearMcpConfigs` for Linear, or
	 * `githubMcpConfigs` for GitHub/GitLab. The list is NOT a blanket
	 * override — it's only consulted when the routed repo does NOT have its
	 * own `allowedTools` override. If the repo has its own allow-list set,
	 * the agent uses `repository.mcpConfigPath` instead so the repo's
	 * permission rules and its server set always come from the same scope
	 * (see `buildIssueConfig`).
	 */
	platformMcpConfigOverrides?: readonly string[];
	linearWorkspaceId?: string;
	cyrusHome: string;
	logger: ILogger;
	onMessage: (message: SDKMessage) => void | Promise<void>;
	onError: (error: Error) => void;
	/** Factory to create AskUserQuestion callback (Claude runner only) */
	createAskUserQuestionCallback?: (
		sessionId: string,
		workspaceId: string,
	) => OnAskUserQuestion;
	/** Resolve the Linear workspace ID for a repository */
	requireLinearWorkspaceId: (repo: RepositoryConfig) => string;
	/** Plugins to load for the session (provides skills, hooks, etc.) */
	plugins?: SdkPluginConfig[];
	/**
	 * Allow-list of skill names enabled for the session (after scope filtering),
	 * or `"all"` to enable every discovered skill, or `undefined` to defer to
	 * provider defaults. Claude passes this to the SDK directly; Codex uses it
	 * to stage the same scoped skills into its native repository discovery layout.
	 */
	skills?: string[] | "all";
	/** SDK sandbox settings (enabled, network proxy ports) for Claude runner */
	sandboxSettings?: SandboxSettings;
	/** CA cert path for MITM TLS termination — passed via child process env */
	egressCaCertPath?: string;
	/**
	 * Resolved auto-compact trigger threshold as a percentage of the model
	 * context window (1–99). When set, threaded into `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`
	 * on the Claude session subprocess so the SDK's built-in auto-compaction
	 * fires earlier than its ~93.5% default (which left too thin a margin for
	 * tool-heavy turns — see CHANGELOG entry on AIN-555).
	 *
	 * Resolution is the caller's responsibility (typically `repo.autoCompactThresholdPercent
	 * ?? edgeConfig.autoCompactThresholdPercent`). When undefined, no override
	 * is injected and the session-env fallback (50) applies.
	 */
	autoCompactThresholdPercent?: number;
}

/**
 * Append the Claude auto-memory directory for the given repository to an
 * `allowedDirectories` list, deduplicating if a caller already added it.
 *
 * Auto-memory is anchored at the bare repo path
 * (`repository.repositoryPath`), not the worktree — Claude Code encodes the
 * bare repo path into `~/.claude/projects/<encoded>/`, so all worktrees of
 * one repo share one memory directory.
 *
 * Without this carve-out, the home-directory Read deny built from cwd +
 * allowedDirectories suppresses access to MEMORY.md and entry files,
 * leaving newly-created memory entries orphaned because agents cannot
 * Read+Edit the index file to add their pointer line.
 */
export function withAutoMemoryAllowedDirectory(
	allowedDirectories: readonly string[],
	repositoryPath: string,
): string[] {
	const memoryDir = getClaudeProjectAutoMemoryDir(repositoryPath);
	if (allowedDirectories.includes(memoryDir)) {
		return [...allowedDirectories];
	}
	return [...allowedDirectories, memoryDir];
}

/**
 * Read the `mcpServers` keys from one or more `.mcp.json` files referenced by
 * `mcpConfigPath`. Used to extend allowedTools' `mcp__<name>` prefix list to
 * also cover servers loaded from disk — without this, repo-registered MCP
 * servers connect at session start but their tools are rejected by allowedTools
 * enforcement (the agent typically misreads the denial as a missing approval
 * prompt).
 *
 * Failures are logged at debug and skipped — never throws, since a missing or
 * malformed file should not block session creation (mirrors ClaudeRunner's
 * tolerant `.mcp.json` parsing).
 */
export function readMcpServerNamesFromPaths(
	mcpConfigPath: string | string[] | undefined,
	logger?: ILogger,
): string[] {
	if (!mcpConfigPath) return [];
	const paths = Array.isArray(mcpConfigPath) ? mcpConfigPath : [mcpConfigPath];
	const names = new Set<string>();
	for (const path of paths) {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			const servers = parsed?.mcpServers;
			if (servers && typeof servers === "object") {
				for (const name of Object.keys(servers)) names.add(name);
			}
		} catch (err) {
			logger?.debug(
				`readMcpServerNamesFromPaths: skipping ${path} (${
					err instanceof Error ? err.message : String(err)
				})`,
			);
		}
	}
	return Array.from(names);
}

export function resolveIssueMcpConfigPath(
	repository: RepositoryConfig,
	platformMcpConfigOverrides: readonly string[] | undefined,
	buildMergedMcpConfigPath: (
		repositories: RepositoryConfig | RepositoryConfig[],
	) => string | string[] | undefined,
): string | string[] | undefined {
	const repoHasAllowedToolsOverride =
		Array.isArray(repository.allowedTools) &&
		repository.allowedTools.length > 0;
	if (repoHasAllowedToolsOverride) {
		return buildMergedMcpConfigPath(repository);
	}

	if (!platformMcpConfigOverrides || platformMcpConfigOverrides.length === 0) {
		return undefined;
	}

	if (platformMcpConfigOverrides.length === 1) {
		return platformMcpConfigOverrides[0];
	}

	return [...platformMcpConfigOverrides];
}

/**
 * Shared runner config assembly for both issue and chat sessions.
 *
 * Eliminates duplication between EdgeWorker.buildAgentRunnerConfig() and
 * ChatSessionHandler.buildRunnerConfig() by providing focused factory methods
 * that produce AgentRunnerConfig objects using injected services.
 */
export class RunnerConfigBuilder {
	private chatToolResolver: IChatToolResolver;
	private mcpConfigProvider: IMcpConfigProvider;
	private runnerSelector: IRunnerSelector;

	constructor(
		chatToolResolver: IChatToolResolver,
		mcpConfigProvider: IMcpConfigProvider,
		runnerSelector: IRunnerSelector,
	) {
		this.chatToolResolver = chatToolResolver;
		this.mcpConfigProvider = mcpConfigProvider;
		this.runnerSelector = runnerSelector;
	}

	/**
	 * Build a runner config for chat sessions (Slack, GitHub chat, etc.).
	 *
	 * Chat sessions get read-only tools + MCP tool prefixes, and a simplified
	 * config without hooks or model selection.
	 */
	async buildChatConfig(
		input: ChatRunnerConfigInput,
	): Promise<AgentRunnerConfig> {
		// MCP config paths for chat sessions: platform override list takes
		// precedence (upstream pattern — `slackMcpConfigs` etc. centralize
		// config across all repos). When no platform override is set, fall back
		// to `repository.mcpConfigPath` (tenfourty pattern — chat sessions
		// inherit the routed repo's `.mcp.json`). Restored so chat sessions
		// load per-repo MCP configs by default on installs without a platform
		// override configured.
		const mcpConfigPath =
			input.platformMcpConfigOverrides &&
			input.platformMcpConfigOverrides.length > 0
				? input.platformMcpConfigOverrides.length === 1
					? input.platformMcpConfigOverrides[0]
					: [...input.platformMcpConfigOverrides]
				: input.repository
					? this.mcpConfigProvider.buildMergedMcpConfigPath(input.repository)
					: undefined;

		// Build fresh MCP config at session start (proactively refreshes the
		// Linear token if stale). This follows the same pattern as
		// buildIssueConfig — never use a pre-baked config.
		const mcpConfig =
			input.linearWorkspaceId && input.repository
				? await this.mcpConfigProvider.buildMcpConfig(
						input.repository.id,
						input.linearWorkspaceId,
						input.sessionId,
					)
				: undefined;

		// Extract MCP tool entries from the repository's allowedTools config
		const userMcpTools = (input.repository?.allowedTools ?? []).filter((tool) =>
			tool.startsWith("mcp__"),
		);

		// Server names come from BOTH the inline mcpConfig (linear/cyrus-tools/
		// cyrus-docs/slack) AND any `.mcp.json` files referenced by mcpConfigPath.
		// Without the file-derived union, repo-registered MCP servers connect but
		// their tools are rejected by allowedTools enforcement.
		const inlineKeys = mcpConfig ? Object.keys(mcpConfig) : [];
		const fileKeys = readMcpServerNamesFromPaths(mcpConfigPath, input.logger);
		const mcpConfigKeys =
			inlineKeys.length || fileKeys.length
				? Array.from(new Set([...inlineKeys, ...fileKeys]))
				: undefined;
		const allowedTools = this.chatToolResolver.buildChatAllowedTools(
			mcpConfigKeys,
			userMcpTools,
		);

		const repositoryPaths = Array.from(
			new Set((input.repositoryPaths ?? []).filter(Boolean)),
		);

		input.logger.debug("Chat session allowed tools:", allowedTools);

		// Shared auto-memory across all chat threads on this platform. Lives
		// under cyrusHome (not the per-thread workspace) so memory built up in
		// one Slack thread is available to every other Slack thread.
		const autoMemoryDirectory = join(
			input.cyrusHome,
			`${input.platformName}-memory`,
		);

		return {
			workingDirectory: input.workspacePath,
			allowedTools,
			disallowedTools: [] as string[],
			allowedDirectories: [
				input.workspacePath,
				autoMemoryDirectory,
				...repositoryPaths,
			],
			workspaceName: input.workspaceName,
			cyrusHome: input.cyrusHome,
			autoMemoryDirectory,
			appendSystemPrompt: appendCloudRuntimeAddendum(
				appendBrowserUseAddendum(appendFailureModeAddendum(input.systemPrompt)),
			),
			...(mcpConfig ? { mcpConfig } : {}),
			...(mcpConfigPath ? { mcpConfigPath } : {}),
			...(input.resumeSessionId
				? { resumeSessionId: input.resumeSessionId }
				: {}),
			...(input.plugins?.length ? { plugins: input.plugins } : {}),
			...(input.skills !== undefined ? { skills: input.skills } : {}),
			logger: input.logger,
			maxTurns: 200,
			onMessage: input.onMessage,
			onError: input.onError,
		};
	}

	/**
	 * Build a runner config for issue sessions (Linear issues, GitHub PRs).
	 *
	 * Issue sessions get full tool sets, runner type selection, model overrides,
	 * hooks, and runner-specific configuration (Chrome, Cursor, etc.).
	 */
	async buildIssueConfig(input: IssueRunnerConfigInput): Promise<{
		config: AgentRunnerConfig;
		runnerType: RunnerType;
	}> {
		const log = input.logger;

		// Configure hooks: PostToolUse for screenshot tools + PR-marker enforcement,
		// plus the Stop hook that blocks the session when work is unshipped.
		const screenshotHooks = this.buildScreenshotHooks(log);
		const prMarkerHook = buildPrMarkerHook(log);
		const intentToAddHook = buildIntentToAddHook(log);
		const stopHook = this.buildStopHook(log);
		const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
			...stopHook,
			PostToolUse: [
				...(screenshotHooks.PostToolUse ?? []),
				...(prMarkerHook.PostToolUse ?? []),
				...(intentToAddHook.PostToolUse ?? []),
			],
		};

		// Determine runner type and model override from selectors
		const runnerSelection = this.runnerSelector.determineRunnerSelection(
			input.labels || [],
			input.issueDescription,
		);
		let runnerType = runnerSelection.runnerType;
		let modelOverride = runnerSelection.modelOverride;
		let fallbackModelOverride = runnerSelection.fallbackModelOverride;

		// If the labels have changed, and we are resuming a session. Use the existing runner for the session.
		if (input.session.claudeSessionId && runnerType !== "claude") {
			runnerType = "claude";
			modelOverride = this.runnerSelector.getDefaultModelForRunner("claude");
			fallbackModelOverride =
				this.runnerSelector.getDefaultFallbackModelForRunner("claude");
		} else if (input.session.geminiSessionId && runnerType !== "gemini") {
			runnerType = "gemini";
			modelOverride = this.runnerSelector.getDefaultModelForRunner("gemini");
			fallbackModelOverride =
				this.runnerSelector.getDefaultFallbackModelForRunner("gemini");
		} else if (input.session.codexSessionId && runnerType !== "codex") {
			runnerType = "codex";
			modelOverride = this.runnerSelector.getDefaultModelForRunner("codex");
			fallbackModelOverride =
				this.runnerSelector.getDefaultFallbackModelForRunner("codex");
		} else if (input.session.cursorSessionId && runnerType !== "cursor") {
			runnerType = "cursor";
			modelOverride = this.runnerSelector.getDefaultModelForRunner("cursor");
			fallbackModelOverride =
				this.runnerSelector.getDefaultFallbackModelForRunner("cursor");
		}

		// Log model override if found
		if (modelOverride) {
			log.debug(`Model override via selector: ${modelOverride}`);
		}

		// Determine final model from selectors, repository override, then runner-specific defaults
		const finalModel =
			modelOverride ||
			input.repository.model ||
			this.runnerSelector.getDefaultModelForRunner(runnerType);

		const resolvedWorkspaceId =
			input.linearWorkspaceId ??
			input.requireLinearWorkspaceId(input.repository);
		const mcpConfig = await this.mcpConfigProvider.buildMcpConfig(
			input.repository.id,
			resolvedWorkspaceId,
			input.sessionId,
		);
		// Repo-override vs platform-default resolution for MCP config paths:
		//   - If the routed repo has its own `allowedTools` override, it
		//     also owns its own MCP config — use `repository.mcpConfigPath`
		//     so the repo-scoped allow-list lines up with the repo-scoped
		//     server set. The two travel as a unit.
		//   - Otherwise the repo inherits the platform's allow-list, and
		//     should likewise inherit the platform's MCP config list
		//     (`linearMcpConfigs` / `githubMcpConfigs`).
		// This guarantees the agent's permission rules and the loaded MCP
		// server set always come from the same scope.
		// Final fallback (`?? buildMergedMcpConfigPath`): `resolveIssueMcpConfigPath`
		// returns undefined when there's no repo-allowed-tools override and no
		// platform override. Upstream is content with undefined there, but
		// tenfourty installs rely on per-repo `.mcp.json` files loading by
		// default (no platform override configured); the fallback restores that
		// behavior so it survives the merge.
		const mcpConfigPath =
			resolveIssueMcpConfigPath(
				input.repository,
				input.platformMcpConfigOverrides,
				this.mcpConfigProvider.buildMergedMcpConfigPath.bind(
					this.mcpConfigProvider,
				),
			) ?? this.mcpConfigProvider.buildMergedMcpConfigPath(input.repository);

		// Multi-repo sessions place each repo in a sibling sub-worktree of the
		// cwd (the workspace container). Register those sub-worktrees as
		// `--add-dir` roots so the runner auto-loads each one's `.claude/skills/`
		// — the cwd-rooted project-skill scan alone would miss them. Single-repo
		// sessions have cwd === the worktree, so there is nothing extra to add.
		//
		// The cwd filter uses the actual resolved working directory (which for
		// multi-repo sessions is the PRIMARY repo's worktree, not the workspace
		// root — see `resolveSessionWorkingDirectory`). Without that, the
		// primary repo would be added as `--add-dir` AND be the cwd, which is
		// redundant and pollutes the `mcp__*` skill-scan log.
		const resolvedCwd = resolveSessionWorkingDirectory(
			input.session,
			input.repository,
		);
		const additionalDirectories = Object.values(
			input.session.workspace.repoPaths ?? {},
		).filter((p): p is string => typeof p === "string" && p !== resolvedCwd);

		// Carve out the per-repo Claude auto-memory directory so the broad
		// home-directory Read deny (built by ClaudeRunner from cwd +
		// allowedDirectories) does not suppress access to the session's
		// MEMORY.md and entry files. Without this, agents successfully
		// create new memory entry files (Write to a new path is fine) but
		// cannot Read+Edit the index, leaving entries orphaned.
		const allowedDirectoriesWithMemory = withAutoMemoryAllowedDirectory(
			input.allowedDirectories,
			input.repository.repositoryPath,
		);

		// Augment allowedTools with `mcp__<name>` prefixes for servers declared
		// via `mcpConfigPath` (mirrors the chat-session fix in buildChatConfig).
		// The ToolPermissionResolver only adds prefixes for INLINE mcpConfig
		// servers; without this union, MCP servers loaded from `.mcp.json` files
		// connect but their tools are rejected by allowedTools enforcement.
		const fileMcpNames = readMcpServerNamesFromPaths(mcpConfigPath, log);
		const allowedToolsWithFileMcps =
			fileMcpNames.length > 0
				? Array.from(
						new Set([
							...input.allowedTools,
							...fileMcpNames.map((n) => `mcp__${n}`),
						]),
					)
				: input.allowedTools;

		const config: AgentRunnerConfig & Record<string, unknown> = {
			workingDirectory: resolvedCwd,
			allowedTools: allowedToolsWithFileMcps,
			disallowedTools: input.disallowedTools,
			allowedDirectories: allowedDirectoriesWithMemory,
			...(additionalDirectories.length > 0 && { additionalDirectories }),
			workspaceName: input.session.issue?.identifier || input.session.issueId,
			cyrusHome: input.cyrusHome,
			mcpConfigPath,
			mcpConfig,
			appendSystemPrompt: appendCloudRuntimeAddendum(
				appendBrowserUseAddendum(appendFailureModeAddendum(input.systemPrompt)),
			),
			// Priority: explicit per-repo config > explicit global config >
			// model-inferred fallback (fallbackModelOverride, which the selector
			// always derives from the model) > hardcoded per-runner default.
			// Explicit config must outrank inference — otherwise a configured
			// chain (the whole point of list-valued fallback) never reaches the
			// SDK, since the inferred override is always set for Claude.
			// normalizeFallbackModel collapses chains to the comma form and maps
			// empty/blank/[] to undefined so `??` falls through correctly (an
			// empty array is otherwise truthy and would mask lower-priority config).
			model: finalModel,
			fallbackModel:
				normalizeFallbackModel(input.repository.fallbackModel) ??
				normalizeFallbackModel(
					this.runnerSelector.getConfiguredFallbackModelForRunner?.(runnerType),
				) ??
				normalizeFallbackModel(fallbackModelOverride) ??
				this.runnerSelector.getDefaultFallbackModelForRunner(runnerType),
			logger: log,
			hooks,
			// Plugins providing managed skills.
			...(this.runnerSupportsManagedSkills(runnerType) &&
				input.plugins?.length && { plugins: input.plugins }),
			// Skill scope allow-list. Claude passes this through to the SDK's
			// `query()` `skills` option; Codex uses it to stage only allowed skill
			// directories into the session worktree for repository-scope discovery.
			...(this.runnerSupportsManagedSkills(runnerType) &&
				input.skills !== undefined && { skills: input.skills }),
			// SDK sandbox settings (Claude runner only):
			// - Merge base settings with per-session filesystem.allowWrite (worktree path)
			// - Pass CA cert path via env for MITM TLS termination
			...(runnerType === "claude" &&
				input.sandboxSettings &&
				this.buildSandboxConfig(input)),
			// AskUserQuestion callback - only for Claude runner
			...(runnerType === "claude" &&
				input.createAskUserQuestionCallback && {
					onAskUserQuestion: input.createAskUserQuestionCallback(
						input.sessionId,
						resolvedWorkspaceId,
					),
				}),
			onMessage: input.onMessage,
			onError: input.onError,
		};

		// Cursor runner uses @cursor/sdk. Pass through API key, the same
		// sandboxSettings shape Claude consumes (the runner translates it to
		// Cursor's `.cursor/sandbox.json` schema), and the egress CA bundle
		// path for MITM TLS trust in sandboxed children. SDK ≥1.0.11
		// auto-discovers the bundled `cursorsandbox` helper from the
		// platform-specific optionalDependency.
		if (runnerType === "cursor") {
			config.cursorApiKey = process.env.CURSOR_API_KEY || undefined;
			if (input.sandboxSettings) {
				config.sandboxSettings = input.sandboxSettings;
			}
			if (input.egressCaCertPath) {
				config.egressCaCertPath = input.egressCaCertPath;
			}
		}

		// When the egress sandbox is enabled, give Codex the same filesystem
		// posture Claude gets (see buildSandboxConfig): writes restricted to the
		// worktree, reads restricted to the worktree + allowed directories (home
		// is denied by omission). The Codex runner turns this into a per-thread
		// app-server permission profile (read/write allow-list).
		if (runnerType === "codex" && input.sandboxSettings) {
			config.sandboxSettings = {
				allowWrite: [input.session.workspace.path],
				allowRead: [input.session.workspace.path, ...input.allowedDirectories],
			};
		}

		if (input.resumeSessionId) {
			config.resumeSessionId = input.resumeSessionId;
		}

		// Cyrus auto-compact threshold → CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
		// for the Claude subprocess. Kept OUTSIDE `buildSandboxConfig`
		// (which only runs when sandboxSettings is set) so the env-var
		// reaches sandbox-disabled installs too — that was the original
		// bug: the config field worked end-to-end on sandbox-enabled
		// hosts and was silently inert on every other install. Merges
		// with `additionalEnv` already produced by the sandbox path so
		// the CA-cert vars (when present) are preserved.
		if (
			runnerType === "claude" &&
			input.autoCompactThresholdPercent !== undefined
		) {
			const existing =
				(config.additionalEnv as Record<string, string> | undefined) ?? {};
			config.additionalEnv = {
				...existing,
				CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(
					input.autoCompactThresholdPercent,
				),
			};
		}

		if (input.maxTurns !== undefined) {
			config.maxTurns = input.maxTurns;
		}

		return { config, runnerType };
	}

	/**
	 * Build a Stop hook that reminds the agent to commit, push, and open a PR
	 * before ending the session. Blocks the first stop attempt and feeds the
	 * guidance back to the agent via the SDK's native `decision: "block"` +
	 * `reason` mechanism. The `stop_hook_active` flag prevents infinite loops —
	 * once the hook has already fired, the next stop is always allowed through.
	 */
	private buildStopHook(
		log: ILogger,
	): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
		return buildStopHook(log);
	}

	private runnerSupportsManagedSkills(runnerType: RunnerType): boolean {
		return runnerType === "claude" || runnerType === "codex";
	}

	/**
	 * Build sandbox and env config for a Claude runner session.
	 * Merges base sandbox settings with per-session filesystem restrictions
	 * (worktree as the only writable directory) and passes the CA cert
	 * for MITM TLS termination via additionalEnv instead of process.env.
	 */
	private buildSandboxConfig(
		input: IssueRunnerConfigInput,
	): Record<string, unknown> {
		const result: Record<string, unknown> = {};

		if (input.sandboxSettings) {
			result.sandbox = {
				...input.sandboxSettings,
				// When sandbox is enabled, do not allow commands to run unsandboxed
				allowUnsandboxedCommands: false,
				// Required for Go-based tools (gh, gcloud, terraform) to verify TLS certs
				// when using httpProxyPort with a MITM proxy and custom CA. macOS only —
				// opens access to com.apple.trustd.agent, which is a potential data
				// exfiltration path. See: https://code.claude.com/docs/en/settings#sandbox-settings
				enableWeakerNetworkIsolation: true,
				filesystem: {
					...input.sandboxSettings.filesystem,
					// "." resolves to the cwd of the primary folder Claude is working in.
					// See: https://code.claude.com/docs/en/settings#sandbox-path-prefixes
					// allowedDirectories contains the attachments dir, repo paths, and git
					// metadata dirs — all of which need OS-level read access alongside the worktree.
					allowRead: [".", ...input.allowedDirectories],
					denyRead: ["~/"],
					// Restrict subprocess writes to the session worktree only
					allowWrite: [input.session.workspace.path],
				},
			};
		}

		if (input.egressCaCertPath) {
			result.additionalEnv = {
				// Node.js (SDK, npm, etc.)
				NODE_EXTRA_CA_CERTS: input.egressCaCertPath,
				// OpenSSL-based tools (general fallback — also covers Ruby)
				SSL_CERT_FILE: input.egressCaCertPath,
				// Git HTTPS operations
				GIT_SSL_CAINFO: input.egressCaCertPath,
				// Python requests/pip
				REQUESTS_CA_BUNDLE: input.egressCaCertPath,
				PIP_CERT: input.egressCaCertPath,
				// curl (when compiled against OpenSSL, not SecureTransport)
				CURL_CA_BUNDLE: input.egressCaCertPath,
				// Rust/Cargo
				CARGO_HTTP_CAINFO: input.egressCaCertPath,
				// AWS CLI / boto3
				AWS_CA_BUNDLE: input.egressCaCertPath,
				// Deno
				DENO_CERT: input.egressCaCertPath,
			};
		}

		return result;
	}

	/**
	 * Build PostToolUse hooks for screenshot/GIF tools that guide Claude
	 * to upload files to Linear using linear_upload_file.
	 */
	private buildScreenshotHooks(
		log: ILogger,
	): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
		return {
			PostToolUse: [
				{
					matcher: "playwright_screenshot",
					hooks: [
						async (input, _toolUseID, { signal: _signal }) => {
							const postToolUseInput = input as PostToolUseHookInput;
							log.debug(
								`Tool ${postToolUseInput.tool_name} completed with response:`,
								postToolUseInput.tool_response,
							);
							const response = postToolUseInput.tool_response as {
								path?: string;
							};
							const filePath = response?.path || "the screenshot file";
							return {
								continue: true,
								additionalContext: `Screenshot taken successfully. To share this screenshot in Linear comments, use the linear_upload_file tool to upload ${filePath}. This will return an asset URL that can be embedded in markdown. You can also use the Read tool to view the screenshot file to analyze the visual content.`,
							};
						},
					],
				},
				{
					matcher: "mcp__chrome-devtools__take_screenshot",
					hooks: [
						async (input, _toolUseID, { signal: _signal }) => {
							const postToolUseInput = input as PostToolUseHookInput;
							// Extract file path from input (the tool saves to filePath parameter)
							const toolInput = postToolUseInput.tool_input as {
								filePath?: string;
							};
							const filePath = toolInput?.filePath || "the screenshot file";
							return {
								continue: true,
								additionalContext: `Screenshot saved. To share this screenshot in Linear comments, use the linear_upload_file tool to upload ${filePath}. This will return an asset URL that can be embedded in markdown.`,
							};
						},
					],
				},
			],
		};
	}
}

/**
 * Build a Stop hook that ensures the agent ships work before ending the
 * session. Inspects the working tree at the session cwd and blocks the first
 * stop attempt when there are uncommitted tracked changes or commits ahead
 * of the upstream branch. The `stop_hook_active` flag prevents infinite
 * loops — once the hook has fired, the next stop is allowed through.
 *
 * Pre-existing untracked files (local scratch files, env files, IDE
 * artifacts outside `.gitignore`) do not trigger the guardrail; new files
 * the agent writes are marked via `IntentToAddHook` so they still appear as
 * a tracked diff and re-trigger the block when forgotten. See CYPACK-1196.
 */
export function buildStopHook(
	log: ILogger,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
	return {
		Stop: [
			{
				matcher: ".*",
				hooks: [
					async (input) => {
						const stopInput = input as StopHookInput;

						// Prevent infinite loops: if the hook already fired, allow the stop.
						if (stopInput.stop_hook_active) {
							return {};
						}

						const guardrail = inspectGitGuardrail(stopInput.cwd, log);
						if (!guardrail) {
							return {};
						}

						return {
							decision: "block",
							reason: guardrail,
						};
					},
				],
			},
		],
	};
}

/**
 * Inspect the working tree at `cwd` and return a guardrail message if there
 * is unshipped work (uncommitted tracked changes or commits ahead of the
 * upstream). Returns null when the tree is clean, when `cwd` isn't a git
 * repo, or when git is unavailable — in those cases the stop is not blocked.
 *
 * Uses `--untracked-files=no` so that pre-existing untracked files in the
 * customer's worktree (scratch files, local env files, IDE artifacts) do not
 * wedge the session. Files Cyrus creates via Write/Edit are marked with
 * `git add --intent-to-add` by `IntentToAddHook` so they still show as a
 * tracked diff and block the stop when left uncommitted.
 */
export function inspectGitGuardrail(cwd: string, log: ILogger): string | null {
	const runGit = (args: string): string => {
		return execSync(`git ${args}`, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	};

	let status: string;
	try {
		status = runGit("status --porcelain --untracked-files=no");
	} catch (err) {
		log.debug(
			`PR guardrail: skipping (cwd is not a git repo or git failed): ${(err as Error).message}`,
		);
		return null;
	}

	const uncommittedFiles = status
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const hasUncommitted = uncommittedFiles.length > 0;

	let unpushedCount = 0;
	try {
		// Count commits reachable from HEAD that are present on NO remote-tracking
		// ref. This is the only measure that matches the guardrail's claim ("not
		// yet on the remote"). Comparing against @{u} or origin/HEAD measured
		// "ahead of upstream/base" instead — which wrongly flagged a fully-pushed
		// feature branch whose upstream happens to track origin/main (a very
		// common state: branched while tracking main, or pushed without -u to its
		// own ref). The whole branch then read as "unpushed", firing the guardrail
		// on every session and driving a comment storm on busy MRs
		// (cove-deploy!24, 2026-06-04). Being ahead of the base branch is the
		// normal state of every open PR/MR and must pass cleanly.
		const hasRemoteRefs =
			runGit("for-each-ref --count=1 refs/remotes").length > 0;
		if (hasRemoteRefs) {
			unpushedCount =
				parseInt(runGit("rev-list --count HEAD --not --remotes"), 10) || 0;
		}
		// No remote-tracking refs at all — can't determine remote state, so be
		// conservative and don't block on commits alone.
	} catch {
		// git unavailable or failed unexpectedly — don't block on commits.
	}

	if (!hasUncommitted && unpushedCount === 0) {
		return null;
	}

	const parts: string[] = [];
	if (hasUncommitted) {
		parts.push(
			`${uncommittedFiles.length} uncommitted file change${uncommittedFiles.length === 1 ? "" : "s"}`,
		);
	}
	if (unpushedCount > 0) {
		parts.push(
			`${unpushedCount} commit${unpushedCount === 1 ? "" : "s"} not yet on the remote`,
		);
	}

	return (
		`You appear to be ending the session, but the working tree has ${parts.join(" and ")}. ` +
		"Before stopping:\n" +
		"1. Commit any uncommitted changes with a descriptive message.\n" +
		"2. Push the branch to the remote.\n" +
		"3. Create or update a pull request that summarizes the change.\n\n" +
		"If the work is genuinely complete and a PR is not appropriate (for example, a question or research task with no intended code changes), you may stop again — this guardrail only blocks once per session."
	);
}
