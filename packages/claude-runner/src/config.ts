/**
 * Claude CLI configuration helpers
 *
 * Skills Documentation:
 * - Claude Code CLI: https://code.claude.com/docs/en/skills
 * - Agent SDK: https://platform.claude.com/docs/en/agent-sdk/skills
 *
 * IMPORTANT: The `allowed-tools` frontmatter field in SKILL.md is only supported
 * when using Claude Code CLI directly. It does not apply when using Skills through
 * the SDK. When using the SDK, control tool access through the main `allowedTools`
 * option in your query configuration.
 */

/**
 * List of all available tools in Claude Code
 */
export const availableTools = [
	// File system tools
	"Read(**)",
	"Edit(**)",
	"Write(**)",

	// Execution tools
	"Bash",
	"Task",

	// Web tools
	"WebFetch",
	"WebSearch",

	// Task management
	"TaskCreate",
	"TaskUpdate",
	"TaskGet",
	"TaskList",

	// Notebook tools
	"NotebookEdit",

	// Skills - enables Claude to use packaged capabilities (SKILL.md files)
	// See: https://platform.claude.com/docs/en/agent-sdk/skills
	"Skill",

	// User interaction tools
	"SendMessage",
	"PushNotification",

	// Plan and worktree management
	"EnterWorktree",
	"ExitWorktree",

	// Scheduling and cron tools
	"CronCreate",
	"CronDelete",
	"CronList",
	"ScheduleWakeup",

	// Monitoring and task lifecycle
	"Monitor",
	"RemoteTrigger",
	"TaskOutput",
	"TaskStop",

	// Tool discovery
	"ToolSearch",

	// Design sync
	"DesignSync",

	// Workflow orchestration
	"Workflow",

	// Findings reporting
	"ReportFindings",
] as const;

export type ToolName = (typeof availableTools)[number];

/**
 * Tools that `ClaudeRunner`'s `canUseTool` callback intercepts and mediates
 * itself (see `createCanUseToolCallback` in `ClaudeRunner.ts`), rather than
 * letting the SDK's own allow/deny model decide.
 *
 * `AskUserQuestion` is conditionally advertised by the SDK: it (along with
 * `EnterPlanMode`/`ExitPlanMode`) only appears in the tool registry when the
 * host process supplies a `canUseTool` callback, which Cyrus always does
 * whenever `onAskUserQuestion` is configured. A bare, callback-less `claude
 * -p` invocation — e.g. `scripts/extract-claude-tools.sh`, which is the
 * documented procedure for refreshing `availableTools` after an SDK bump —
 * cannot observe these tools, so `availableTools` must never gain them back
 * from a naive refresh. Any list derived from `availableTools` (such as the
 * subagent `allowedTools` widening in `ClaudeRunner.ts`) must explicitly
 * exclude `INTERCEPTED_TOOLS` so a future refresh can't silently smuggle
 * `AskUserQuestion` into an unconditional allow list and bypass the
 * one-question-at-a-time guard.
 */
export const INTERCEPTED_TOOLS = ["AskUserQuestion"] as const;

export type InterceptedToolName = (typeof INTERCEPTED_TOOLS)[number];

/**
 * Remove any `INTERCEPTED_TOOLS` name from a tool list.
 *
 * Used by `ClaudeRunner` when widening a subagent's inherited `allowedTools`
 * to mirror the parent's effective permission surface (see the widening
 * comment in `ClaudeRunner.ts`). Subagents dispatched via the Agent tool do
 * not inherit `canUseTool`, so any intercepted tool that slipped into that
 * widened list would fall through to the SDK's default-allow instead of
 * being mediated — this is the choke point that keeps that from happening.
 */
export function excludeInterceptedTools(tools: readonly string[]): string[] {
	return tools.filter(
		(tool) => !(INTERCEPTED_TOOLS as readonly string[]).includes(tool),
	);
}

/**
 * Default read-only tools that are safe to enable
 * Note: Task tools are included as they only modify task tracking, not actual code files
 * Note: Skill is included as it enables Claude to use Skills which are packaged capabilities
 */
export const readOnlyTools: ToolName[] = [
	"Read(**)",
	"WebFetch",
	"WebSearch",
	"TaskCreate",
	"TaskUpdate",
	"TaskGet",
	"TaskList",
	"Task",
	"Skill",
	"Monitor",
	"TaskOutput",
	"ToolSearch",
];

/**
 * Tools that can modify the file system or state
 */
export const writeTools: ToolName[] = [
	"Edit(**)",
	"Write(**)",
	"Bash",
	"NotebookEdit",
];

/**
 * Get a safe set of tools for read-only operations
 */
export function getReadOnlyTools(): string[] {
	return [...readOnlyTools];
}

/**
 * Get all available tools
 */
export function getAllTools(): string[] {
	return [...availableTools];
}

/**
 * Get all tools except Bash (safer default for repository configuration)
 */
export function getSafeTools(): string[] {
	return [...availableTools].filter((t) => t !== "Bash");
}

/**
 * Get coordinator tools - all tools except those that can edit files
 * Excludes: Edit, Write, NotebookEdit (no file/content modification)
 * Used by orchestrator role for coordination without direct file modification
 */
export function getCoordinatorTools(): string[] {
	return [...availableTools].filter(
		(t) => t !== "Edit(**)" && t !== "Write(**)" && t !== "NotebookEdit",
	);
}
