import { z } from "zod";

/**
 * Supported runner/harness types for agent execution.
 */
export const RunnerTypeSchema = z.enum(["claude", "gemini", "codex", "cursor"]);
export type RunnerType = z.infer<typeof RunnerTypeSchema>;

/**
 * User identifier for access control matching.
 * Supports multiple formats for flexibility:
 * - String: treated as user ID (e.g., "usr_abc123")
 * - Object with id: explicit user ID match
 * - Object with email: email-based match
 */
export const UserIdentifierSchema = z.union([
	z.string(), // Treated as user ID
	z.object({ id: z.string() }), // Explicit user ID
	z.object({ email: z.string() }), // Email address
]);

/**
 * User access control configuration for whitelisting/blacklisting users.
 */
export const UserAccessControlConfigSchema = z.object({
	/**
	 * Users allowed to delegate issues.
	 * If specified, ONLY these users can trigger Cyrus sessions.
	 * Empty array means no one is allowed (effectively disables Cyrus).
	 * Omitting this field means everyone is allowed (unless blocked).
	 */
	allowedUsers: z.array(UserIdentifierSchema).optional(),

	/**
	 * Users blocked from delegating issues.
	 * These users cannot trigger Cyrus sessions.
	 * Takes precedence over allowedUsers.
	 */
	blockedUsers: z.array(UserIdentifierSchema).optional(),

	/**
	 * What happens when a blocked user tries to delegate.
	 * - 'silent': Ignore the webhook quietly (default)
	 * - 'comment': Post an activity explaining the user is not authorized
	 */
	blockBehavior: z.enum(["silent", "comment"]).optional(),

	/**
	 * Custom message to post when blockBehavior is 'comment'.
	 * Defaults to: "You are not authorized to delegate issues to this agent."
	 */
	blockMessage: z.string().optional(),
});

/**
 * Tool restriction options for label-based prompts
 */
const ToolRestrictionSchema = z.union([
	z.array(z.string()),
	z.literal("readOnly"),
	z.literal("safe"),
	z.literal("all"),
	z.literal("coordinator"),
]);

/**
 * Label prompt configuration with optional tool restrictions.
 * Accepts either:
 * - Simple form: string[] (e.g., ["Bug", "Fix"])
 * - Complex form: { labels: string[], allowedTools?: ..., disallowedTools?: ... }
 */
const LabelPromptConfigSchema = z.union([
	// Simple form: just an array of label strings
	z.array(z.string()),
	// Complex form: object with labels and optional tool restrictions
	z.object({
		labels: z.array(z.string()),
		allowedTools: ToolRestrictionSchema.optional(),
		disallowedTools: z.array(z.string()).optional(),
	}),
]);

/**
 * Graphite label configuration (labels only, no tool restrictions).
 * Accepts either:
 * - Simple form: string[] (e.g., ["Bug", "Fix"])
 * - Complex form: { labels: string[] }
 */
const GraphiteLabelConfigSchema = z.union([
	z.array(z.string()),
	z.object({
		labels: z.array(z.string()),
	}),
]);

/**
 * Label-based system prompt configuration
 */
const LabelPromptsSchema = z.object({
	debugger: LabelPromptConfigSchema.optional(),
	builder: LabelPromptConfigSchema.optional(),
	scoper: LabelPromptConfigSchema.optional(),
	orchestrator: LabelPromptConfigSchema.optional(),
	"graphite-orchestrator": LabelPromptConfigSchema.optional(),
	graphite: GraphiteLabelConfigSchema.optional(),
});

/**
 * Prompt type defaults configuration
 */
const PromptTypeDefaultsSchema = z.object({
	allowedTools: ToolRestrictionSchema.optional(),
	disallowedTools: z.array(z.string()).optional(),
});

/**
 * Header transform rule for egress proxy.
 * Injects or overrides HTTP headers on outgoing requests to a specific domain.
 * Follows the Vercel Sandbox Firewall transform interface.
 *
 * @see https://vercel.com/docs/vercel-sandbox/concepts/firewall
 */
const HeaderTransformSchema = z.object({
	/** Headers to inject/override on outgoing requests */
	headers: z.record(z.string(), z.string()),
});

/**
 * Per-domain allow rule with optional header transforms.
 * When transforms are specified, TLS is terminated for that domain
 * so headers can be inspected and modified (credentials brokering).
 */
const DomainRuleSchema = z.array(
	z.object({
		transform: z.array(HeaderTransformSchema).optional(),
	}),
);

/**
 * Network policy for egress sandboxing.
 * Controls which domains/subnets Bash-spawned subprocesses (git, gh, npm,
 * curl, etc.) can reach and enables per-domain header injection
 * (credentials brokering).
 *
 * Three modes (following Vercel Sandbox Firewall conventions):
 * - **allow-all**: No networkPolicy set — unrestricted access (default)
 * - **deny-all**: networkPolicy set with no `allow` rules — blocks all traffic
 * - **user-defined**: networkPolicy with `allow` rules — deny-all by default,
 *   only explicitly listed domains are reachable
 *
 * Scope: Claude Code's sandbox network proxy only intercepts traffic from
 * Bash tool subprocesses. It does NOT apply to Claude's own inference API
 * calls, MCP server traffic, or built-in file tools (Read/Edit/Write).
 *
 * @see https://docs.anthropic.com/en/docs/claude-code/security#sandbox
 * @see https://vercel.com/docs/vercel-sandbox/concepts/firewall#network-policies
 */
export const NetworkPolicySchema = z.object({
	/**
	 * Network policy preset. When set, pre-populates the allow list with
	 * a curated set of domains. Additional `allow` rules are merged on top.
	 *
	 * - `"trusted"`: ~200 domains matching Claude Code on the web's default
	 *   allowlist — package registries, version control, cloud platforms,
	 *   container registries, dev tools, and monitoring services.
	 *
	 * @see https://docs.anthropic.com/en/docs/claude-code/claude-code-on-the-web#default-allowed-domains
	 */
	preset: z.enum(["trusted"]).optional(),

	/**
	 * Domain allow rules with optional transforms.
	 * When present, all unlisted domains are denied (deny-all default).
	 * Keys are domain patterns:
	 * - Exact match: "api.example.com"
	 * - Wildcard subdomain: "*.example.com" (matches any subdomain, NOT parent)
	 * - Wildcard segment: "www.*.com" (matches one segment)
	 *
	 * When a preset is also set, these rules are merged on top of the
	 * preset's domains (custom rules take precedence).
	 */
	allow: z.record(z.string(), DomainRuleSchema).optional(),

	/** Subnet-based rules */
	subnets: z
		.object({
			/** IP ranges to allow (bypasses domain matching) */
			allow: z.array(z.string()).optional(),
			/** IP ranges to deny (takes precedence over all allow rules) */
			deny: z.array(z.string()).optional(),
		})
		.optional(),
});

/**
 * Sandbox configuration for network egress control.
 * Configures the egress proxy that intercepts outbound traffic from
 * Bash-spawned subprocesses in agent sessions.
 *
 * When enabled, the proxy starts on EdgeWorker boot and sandbox
 * network ports are passed to the Claude Agent SDK per-session.
 * Only Bash tool commands (git, gh, npm, curl, etc.) route through
 * the proxy — Claude's inference API, MCP servers, and built-in
 * file tools are unaffected.
 *
 * @see https://docs.anthropic.com/en/docs/claude-code/security#sandbox
 */
export const SandboxConfigSchema = z.object({
	/**
	 * Enable or disable the egress proxy.
	 * When true, the proxy starts on EdgeWorker boot and sandbox network ports
	 * are passed to Claude Agent SDK sessions to route traffic through it.
	 * @default false
	 */
	enabled: z.boolean().optional(),

	/** HTTP proxy port for SDK sandbox.network.httpProxyPort */
	httpProxyPort: z.number().optional().default(9080),

	/** SOCKS proxy port for SDK sandbox.network.socksProxyPort */
	socksProxyPort: z.number().optional().default(9081),

	/**
	 * Network policy controlling allowed domains, transforms, and subnets.
	 * If omitted, all traffic is allowed (passthrough mode with logging).
	 */
	networkPolicy: NetworkPolicySchema.optional(),

	/**
	 * Whether the CA certificate has been trusted system-wide (e.g., via
	 * `sudo security add-trusted-cert` on macOS). When true, per-session
	 * CA cert env vars (NODE_EXTRA_CA_CERTS, GIT_SSL_CAINFO, etc.) are
	 * skipped — the OS cert store handles trust for all tools.
	 * @default false
	 */
	systemWideCert: z.boolean().optional(),

	/**
	 * Log all proxied requests (method, URL, domain, status).
	 * @default true
	 */
	logRequests: z.boolean().optional(),
});

/**
 * Global defaults for prompt types
 */
const PromptDefaultsSchema = z.object({
	debugger: PromptTypeDefaultsSchema.optional(),
	builder: PromptTypeDefaultsSchema.optional(),
	scoper: PromptTypeDefaultsSchema.optional(),
	orchestrator: PromptTypeDefaultsSchema.optional(),
	"graphite-orchestrator": PromptTypeDefaultsSchema.optional(),
});

/**
 * Configuration for a Linear workspace's credentials.
 * Keyed by workspace ID in EdgeConfig.linearWorkspaces.
 */
export const LinearWorkspaceConfigSchema = z.object({
	linearToken: z.string(),
	linearRefreshToken: z.string().optional(),
	/**
	 * Absolute expiry of `linearToken` (epoch ms), recorded on each OAuth
	 * refresh. Lets sessions proactively refresh a stale token before handing
	 * it to consumers that cannot self-refresh (e.g. the Linear MCP server).
	 */
	linearTokenExpiresAt: z.number().optional(),
	/** Linear workspace URL slug (e.g., "ceedar" from "https://linear.app/ceedar/...") */
	linearWorkspaceSlug: z.string().optional(),
	/** Human-readable workspace name (e.g., "Ceedar") */
	linearWorkspaceName: z.string().optional(),
});

/**
 * Configuration for a single repository/workspace pair
 */
/**
 * Optional per-turn telemetry configuration. Off by default.
 * Settable globally on EdgeConfig and overridable per-repo on RepositoryConfig
 * via a shallow merge (repo fields win when set).
 */
export const TelemetryConfigSchema = z.object({
	/** Master switch. Off by default — when false (or absent) no telemetry side effects. */
	enabled: z.boolean().optional(),
	/** Append per-turn footer to result activity body. Defaults true when enabled. */
	linearFooter: z.boolean().optional(),
	/** Directory for NDJSON files. Defaults `<cyrusHome>/telemetry`. */
	ndjsonDir: z.string().optional(),
	/**
	 * Tier-1 OTLP passthrough — when `endpoint` is set, Cyrus injects
	 * CLAUDE_CODE_ENABLE_TELEMETRY=1 plus OTEL_* env vars into the
	 * Claude Agent SDK subprocess so its native OTel export ships
	 * directly to the operator's collector. Non-Claude runners are
	 * unaffected (their CLIs don't emit OTel natively in v1).
	 */
	otlp: z
		.object({
			endpoint: z.string(),
			protocol: z.enum(["grpc", "http/protobuf"]).optional(),
			headers: z.record(z.string(), z.string()).optional(),
		})
		.optional(),
});

export const RepositoryConfigSchema = z.object({
	// Repository identification
	id: z.string(),
	name: z.string(),

	// Git configuration
	repositoryPath: z.string(),
	baseBranch: z.string(),
	githubUrl: z.string().optional(),
	gitlabUrl: z.string().optional(),

	// Linear configuration (optional — repos may operate without Linear, e.g. via Slack or GitHub)
	linearWorkspaceId: z.string().optional(),
	teamKeys: z.array(z.string()).optional(),
	routingLabels: z.array(z.string()).optional(),
	projectKeys: z.array(z.string()).optional(),

	/** @deprecated Use EdgeConfig.linearWorkspaces[workspaceId].linearToken */
	linearToken: z.string().optional(),
	/** @deprecated Use EdgeConfig.linearWorkspaces[workspaceId].linearRefreshToken */
	linearRefreshToken: z.string().optional(),
	/** @deprecated Use EdgeConfig.linearWorkspaces[workspaceId].linearWorkspaceName */
	linearWorkspaceName: z.string().optional(),

	// Workspace configuration
	workspaceBaseDir: z.string(),

	// Optional settings
	isActive: z.boolean().optional(),
	promptTemplatePath: z.string().optional(),
	allowedTools: z.array(z.string()).optional(),
	disallowedTools: z.array(z.string()).optional(),
	mcpConfigPath: z.union([z.string(), z.array(z.string())]).optional(),
	appendInstruction: z.string().optional(),
	verificationCommand: z.string().optional(),
	/**
	 * Repo IDs of OTHER registered repositories that should automatically
	 * participate in any session routed to THIS repository. Useful for
	 * setups where a primary code repository always needs a sibling
	 * operations or shared-library repository (for runbooks, deploy
	 * wrappers, shared types, etc.). The matched primary stays primary;
	 * siblings are appended as participants.
	 *
	 * One-way directional: setting this on repo A does NOT cause sessions
	 * routed to repo B to auto-include repo A. Mirror the field manually
	 * if you want symmetric pairing.
	 *
	 * Skipped when the user explicitly specifies repos via a description
	 * tag like `[repo=a,b]` — the tag is treated as an explicit override.
	 */
	siblingParticipants: z.array(z.string()).optional(),
	model: z.string().optional(),
	// A single model name/alias, or an ordered chain tried in turn when the
	// primary is overloaded/unavailable. Chains are joined with commas at the
	// SDK boundary (see normalizeFallbackModel).
	fallbackModel: z.union([z.string(), z.array(z.string())]).optional(),

	// Label-based system prompt configuration
	labelPrompts: LabelPromptsSchema.optional(),

	// Repository-specific user access control
	userAccessControl: UserAccessControlConfigSchema.optional(),

	/**
	 * When true, sessions persisted under this repository that were `active`
	 * at the time Cyrus shut down are auto-respawned at startup. Defaults to
	 * false so existing installs see no behavior change. See `EdgeConfig.autoResume`
	 * for fleet-wide tuning (concurrency, jitter, TTL, hold label).
	 */
	autoResumeOnStartup: z.boolean().optional(),

	/**
	 * Auto-compact trigger threshold as a percentage of the model context
	 * window. When the session's recorded context exceeds this fraction,
	 * the Claude runner's built-in auto-compaction fires mid-turn (via the
	 * `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` env var) so sessions stay inside
	 * the window with margin to spare for the next turn.
	 *
	 * Per-repo override of `EdgeConfig.autoCompactThresholdPercent`. Range
	 * 1–99. Falls back to the global value when omitted; when BOTH are
	 * omitted no override is injected and the SDK's built-in default
	 * (~93.5%) applies. The number is harness-agnostic: each runner
	 * translates it to its own SDK knob (Claude →
	 * `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`; Codex/Gemini/Cursor will pick up
	 * an equivalent as their SDKs expose one).
	 */
	autoCompactThresholdPercent: z.number().int().min(1).max(99).optional(),

	/** Per-repo override of EdgeConfig.telemetry (shallow merge — repo fields win). */
	telemetry: TelemetryConfigSchema.optional(),
});

/**
 * Global tuning for auto-resume of in-flight sessions on startup.
 * Per-repository participation is gated by `RepositoryConfig.autoResumeOnStartup`;
 * this block only matters once at least one repository opts in.
 */
export const AutoResumeConfigSchema = z.object({
	/** Cap on concurrent `resumeSession` calls during startup drain. */
	concurrency: z.number().int().positive().optional(),
	/** [minMs, maxMs] jitter range applied between resume starts. */
	staggerMs: z
		.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
		.refine(([min, max]) => min <= max, {
			message: "staggerMs must be [minMs, maxMs] with minMs <= maxMs",
		})
		.optional(),
	/**
	 * Sessions whose `updatedAt` is older than this TTL are skipped at
	 * startup. Set to 0 to disable the staleness check.
	 */
	maxAgeMs: z.number().int().nonnegative().optional(),
	/**
	 * Linear label that pauses auto-resume for an issue. Match is
	 * case-insensitive. Empty string disables the check.
	 */
	holdLabel: z.string().optional(),
	/**
	 * Whether to post a "resumed after restart" thought activity to Linear
	 * when a session is respawned. Skip notifications stay silent regardless
	 * (operators chose those states).
	 */
	notifyOnResume: z.boolean().optional(),
});

/**
 * Edge configuration - the serializable configuration stored in ~/.cyrus/config.json
 *
 * This schema defines all settings that can be persisted to disk.
 * It contains global settings that apply across all repositories,
 * plus the array of repository-specific configurations.
 */
export const EdgeConfigSchema = z.object({
	/** Array of repository configurations */
	repositories: z.array(RepositoryConfigSchema),

	/**
	 * Linear workspace credentials keyed by workspace ID.
	 * Centralizes tokens that were previously duplicated per-repository.
	 */
	linearWorkspaces: z
		.record(z.string(), LinearWorkspaceConfigSchema)
		.optional(),

	/** @deprecated Migrated into linearWorkspaces entries. */
	linearWorkspaceSlug: z.string().optional(),

	/** Ngrok auth token for tunnel creation */
	ngrokAuthToken: z.string().optional(),

	/** Stripe customer ID for billing */
	stripeCustomerId: z.string().optional(),

	/** Default Claude model to use across all repositories (e.g., "opus", "sonnet", "haiku") */
	claudeDefaultModel: z.string().optional(),

	/**
	 * Default Claude fallback model if the primary Claude model is unavailable.
	 * A single model name/alias, or an ordered chain (tried in turn) expressed
	 * as an array.
	 */
	claudeDefaultFallbackModel: z
		.union([z.string(), z.array(z.string())])
		.optional(),

	/** Default Gemini model to use across all repositories (e.g., "gemini-2.5-pro") */
	geminiDefaultModel: z.string().optional(),

	/** Default Codex model to use across all repositories (e.g., "gpt-5.5", "gpt-5.4", "gpt-5.3-codex") */
	codexDefaultModel: z.string().optional(),

	/** Default Cursor model to use across all repositories (e.g., "composer-2", "gpt-5.4") */
	cursorDefaultModel: z.string().optional(),

	/** Default Cursor fallback model if primary Cursor model is unavailable */
	cursorDefaultFallbackModel: z.string().optional(),

	/**
	 * Default runner/harness to use when no runner is specified via labels or description tags.
	 * If omitted, auto-detected from available API keys (if exactly one is configured),
	 * otherwise falls back to "claude".
	 */
	defaultRunner: RunnerTypeSchema.optional(),

	/**
	 * @deprecated Use claudeDefaultModel instead.
	 * Legacy field retained for backwards compatibility and migrated on load.
	 */
	defaultModel: z.string().optional(),

	/**
	 * @deprecated Use claudeDefaultFallbackModel instead.
	 * Legacy field retained for backwards compatibility and migrated on load.
	 */
	defaultFallbackModel: z.union([z.string(), z.array(z.string())]).optional(),

	/** Optional path to global setup script that runs for all repositories */
	global_setup_script: z.string().optional(),

	/**
	 * Allowed tools for Linear-triggered agent sessions. Renamed from the
	 * old `defaultAllowedTools` to make the platform scope explicit alongside
	 * `slackAllowedTools` and `githubAllowedTools`.
	 */
	linearAllowedTools: z.array(z.string()).optional(),

	/**
	 * @deprecated Use linearAllowedTools instead. Legacy field retained for
	 * older self-host CLI consumers that still write the old name; migrated
	 * forward on load via `migrateEdgeConfig`.
	 */
	defaultAllowedTools: z.array(z.string()).optional(),

	/** Tools to explicitly disallow across all repositories */
	defaultDisallowedTools: z.array(z.string()).optional(),

	/**
	 * Allowed tools for Slack @mention chat sessions. When set, overrides the
	 * built-in read-only chat tool set used by ToolPermissionResolver. The
	 * workspace MCP tool prefixes (mcp__linear, mcp__cyrus-tools, etc.) are
	 * still appended automatically.
	 */
	slackAllowedTools: z.array(z.string()).optional(),

	/**
	 * Allowed tools for GitHub-triggered agent sessions. When set, overrides
	 * `linearAllowedTools` specifically for sessions originating from GitHub
	 * (PR comments, automated fix-on-failure flows, etc.).
	 */
	githubAllowedTools: z.array(z.string()).optional(),

	/**
	 * Filesystem paths to custom-integration MCP config JSON files (Claude
	 * Code `.mcp.json` format) the runtime should load for Slack `@mention`
	 * chat sessions. Chat sessions are repo-agnostic, so
	 * `repository.mcpConfigPath` is not consulted here — only this list
	 * determines which custom `.mcp.json` files load for Slack. When
	 * omitted/empty, no custom files load (native MCP servers — Linear,
	 * Cyrus tools, Slack MCP, Cyrus docs — still run as usual).
	 *
	 * The per-platform lists let cyrus-hosted route custom MCP server
	 * availability per surface — e.g. expose `slack-mcp-server` only on
	 * Slack, or scope a Supabase MCP to GitHub PR sessions but not Linear
	 * issue work. Each entry is passed as-is to Claude Code's
	 * `--mcp-config` mechanism.
	 */
	slackMcpConfigs: z.array(z.string()).optional(),

	/**
	 * Filesystem paths to custom-integration MCP config JSON files for
	 * Linear-triggered agent sessions. NOT a blanket override — this list
	 * is only consulted when the routed repo does NOT have its own
	 * `allowedTools` override. If the repo has its own allow-list set, the
	 * agent uses `repository.mcpConfigPath` instead so the repo's
	 * permission rules and its server set always come from the same scope.
	 * When omitted/empty AND the repo has no override, no custom `.mcp.json`
	 * files load.
	 */
	linearMcpConfigs: z.array(z.string()).optional(),

	/**
	 * Filesystem paths to custom-integration MCP config JSON files for
	 * GitHub/GitLab-triggered agent sessions. Same repo-override-coupling
	 * semantics as `linearMcpConfigs`: only consulted when the routed repo
	 * does not have its own `allowedTools` override; otherwise the repo's
	 * `mcpConfigPath` is used.
	 */
	githubMcpConfigs: z.array(z.string()).optional(),

	/**
	 * Whether to trigger agent sessions when issue title, description, or attachments are updated.
	 * When enabled, the agent receives context showing what changed (old vs new values).
	 * Defaults to true if not specified.
	 */
	issueUpdateTrigger: z.boolean().optional(),

	/**
	 * Whether Cyrus follows along with all subsequent replies in a Slack thread
	 * it has been @mentioned in (treating each reply as a follow-up prompt).
	 * When false, Cyrus only responds to explicit @mentions. Defaults to true if
	 * not specified. Can also be force-disabled at runtime via the
	 * `CYRUS_SLACK_THREAD_FOLLOWING_DISABLED` environment variable.
	 */
	slackThreadFollowing: z.boolean().optional(),

	/**
	 * Whether to trigger agent sessions when a pull request review requests changes.
	 * When disabled, a `pull_request_review` event produces no acknowledgement comment
	 * and no agent session. Defaults to true if not specified.
	 */
	prReviewTrigger: z.boolean().optional(),

	/**
	 * Global user access control settings.
	 * Applied to all repositories unless overridden.
	 */
	userAccessControl: UserAccessControlConfigSchema.optional(),

	/** Global defaults for prompt types (tool restrictions per prompt type) */
	promptDefaults: PromptDefaultsSchema.optional(),

	/**
	 * Sandbox configuration for network egress control.
	 * When enabled, starts an egress proxy and configures Claude Code to route
	 * all agent network traffic through it for inspection and filtering.
	 */
	sandbox: SandboxConfigSchema.optional(),

	/**
	 * Tuning for auto-resume of in-flight sessions on startup. Only applied
	 * when at least one repository opts in via `autoResumeOnStartup: true`.
	 */
	autoResume: AutoResumeConfigSchema.optional(),

	/**
	 * Auto-compact trigger threshold as a percentage of the model context
	 * window (1–99). When a session's recorded context exceeds this fraction,
	 * the Claude runner's built-in auto-compaction fires mid-turn (via the
	 * `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` env var).
	 *
	 * Global default; per-repo `RepositoryConfig.autoCompactThresholdPercent`
	 * overrides this. When BOTH are omitted, no override is injected and
	 * the SDK's built-in default (~93.5%) applies, preserving existing
	 * install behavior. Operators on heavy-tool workloads should set 50–75%
	 * — see CHANGELOG entry for the background on why the SDK default left
	 * too thin a margin on long-running sessions.
	 */
	autoCompactThresholdPercent: z.number().int().min(1).max(99).optional(),

	/**
	 * Per-turn AI usage telemetry. Off by default. When enabled, appends
	 * a one-line footer to each agent response in Linear, posts a
	 * session-totals rollup on terminal state, and writes per-turn
	 * NDJSON records to `<cyrusHome>/telemetry/<sessionId>.jsonl` (or
	 * the configured ndjsonDir) for offline analysis. Per-repo settings
	 * on RepositoryConfig.telemetry override these globally.
	 */
	telemetry: TelemetryConfigSchema.optional(),
});

/**
 * Payload version of RepositoryConfigSchema for incoming API requests.
 * Makes workspaceBaseDir optional since the handler applies a default.
 */
export const RepositoryConfigPayloadSchema = RepositoryConfigSchema.extend({
	workspaceBaseDir: z.string().optional(),
});

/**
 * Payload version of EdgeConfigSchema for incoming API requests.
 * Uses RepositoryConfigPayloadSchema which has optional workspaceBaseDir.
 */
export const EdgeConfigPayloadSchema = EdgeConfigSchema.extend({
	repositories: z.array(RepositoryConfigPayloadSchema),
});

/**
 * Migrate an EdgeConfig from the legacy per-repo token format to the
 * workspace-keyed format.
 *
 * Old format: each repository has linearToken and linearRefreshToken.
 * New format: linearWorkspaces at EdgeConfig level keyed by workspace ID,
 * repositories no longer carry tokens.
 *
 * This function is idempotent — if linearWorkspaces already exists, it
 * returns the config unchanged.
 */
export function migrateEdgeConfig(
	input: Record<string, unknown>,
): Record<string, unknown> {
	// `defaultAllowedTools` → `linearAllowedTools`. Older self-host CLIs and
	// any config file written before the rename still ship the old key; fold
	// it forward in-place. We do NOT delete the old key — newer consumers
	// ignore it, and an older runtime that still reads the old key keeps
	// working until it's upgraded.
	const raw: Record<string, unknown> =
		Array.isArray(input.defaultAllowedTools) &&
		input.linearAllowedTools === undefined
			? { ...input, linearAllowedTools: input.defaultAllowedTools }
			: input;

	// Already migrated or no repositories — nothing else to do
	if (raw.linearWorkspaces || !Array.isArray(raw.repositories)) {
		return raw;
	}

	const repos = raw.repositories as Record<string, unknown>[];
	const hasLegacyTokens = repos.some((r) => typeof r.linearToken === "string");

	if (!hasLegacyTokens) {
		return raw;
	}

	// Build workspace map from per-repo tokens
	const linearWorkspaces: Record<
		string,
		{
			linearToken: string;
			linearRefreshToken?: string;
			linearWorkspaceSlug?: string;
			linearWorkspaceName?: string;
		}
	> = {};

	// Grab the top-level slug (if present) so it can be folded into each workspace
	const globalSlug = raw.linearWorkspaceSlug as string | undefined;

	for (const repo of repos) {
		const workspaceId = repo.linearWorkspaceId as string | undefined;
		const token = repo.linearToken as string | undefined;
		if (workspaceId && token) {
			// First repo with this workspace wins (they should all have the same token)
			if (!linearWorkspaces[workspaceId]) {
				linearWorkspaces[workspaceId] = {
					linearToken: token,
					...(typeof repo.linearRefreshToken === "string"
						? { linearRefreshToken: repo.linearRefreshToken }
						: {}),
					...(globalSlug ? { linearWorkspaceSlug: globalSlug } : {}),
					...(typeof repo.linearWorkspaceName === "string"
						? { linearWorkspaceName: repo.linearWorkspaceName }
						: {}),
				};
			}
		}
	}

	// Strip legacy token fields and workspace name from repositories
	const migratedRepos = repos.map((repo) => {
		const {
			linearToken: _linearToken,
			linearRefreshToken: _linearRefreshToken,
			linearWorkspaceName: _linearWorkspaceName,
			...rest
		} = repo;
		return rest;
	});

	const { linearWorkspaceSlug: _slug, ...rest } = raw;

	return {
		...rest,
		repositories: migratedRepos,
		linearWorkspaces,
	};
}

// Infer types from schemas
export type UserIdentifier = z.infer<typeof UserIdentifierSchema>;
export type UserAccessControlConfig = z.infer<
	typeof UserAccessControlConfigSchema
>;
export type LinearWorkspaceConfig = z.infer<typeof LinearWorkspaceConfigSchema>;
export type RepositoryConfig = z.infer<typeof RepositoryConfigSchema>;
export type EdgeConfig = z.infer<typeof EdgeConfigSchema>;
export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;
export type NetworkPolicy = z.infer<typeof NetworkPolicySchema>;
export type RepositoryConfigPayload = z.infer<
	typeof RepositoryConfigPayloadSchema
>;
export type EdgeConfigPayload = z.infer<typeof EdgeConfigPayloadSchema>;
export type TelemetryConfig = z.infer<typeof TelemetryConfigSchema>;

/**
 * Assert that a repository has a Linear workspace ID and return it.
 * Use this in code paths that are only reached for Linear-linked repositories
 * (e.g. webhook handlers routed via workspace ID).
 */
export function requireLinearWorkspaceId(repo: RepositoryConfig): string {
	if (!repo.linearWorkspaceId) {
		throw new Error(
			`Repository "${repo.name}" is not linked to a Linear workspace`,
		);
	}
	return repo.linearWorkspaceId;
}
