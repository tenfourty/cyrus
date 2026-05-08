/**
 * Shared session environment and MCP config utilities.
 *
 * These helpers DRY up logic that was previously duplicated between
 * ClaudeRunner (query options) and EdgeWorker (warmup / startup).
 */

/**
 * Auth-related env vars forwarded from the parent process.
 * The SDK subprocess needs these for API calls.
 */
const AUTH_ENV_KEYS = [
	"ANTHROPIC_API_KEY",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"ANTHROPIC_AUTH_TOKEN",
] as const;

/**
 * Cyrus-specific env vars injected into every Claude Code subprocess.
 * Both `ClaudeRunner.start()` and `EdgeWorker.warmupRecentSessions()`
 * must use the same set — keep this as the single source of truth.
 *
 * Note: CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is intentionally not included
 * while the Linux bubblewrap sandbox side effects it triggers are being
 * investigated. See CYPACK-1108.
 *
 * - MCP_CONNECTION_NONBLOCKING lets MCP servers connect in the background so
 *   both cold-start and pre-warm sessions return faster.
 * - CLAUDE_CODE_STREAM_CLOSE_TIMEOUT raises the SDK's idle-stream timeout so
 *   long tool calls and `canUseTool` round-trips don't trip the premature
 *   stream close documented upstream in
 *   https://github.com/anthropics/claude-agent-sdk-typescript/issues/114
 *   (cluster of "Tool permission request failed: Stream closed" reports —
 *   #98 closed as a duplicate of #114). 10 minutes covers the slowest tool
 *   we run today; operators can override per-repo via `.env` or via the
 *   runner's `additionalEnv` config.
 */
export const CYRUS_SESSION_ENV = {
	CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1",
	CLAUDE_CODE_ENABLE_TASKS: "true",
	CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
	CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
	MCP_CONNECTION_NONBLOCKING: "true",
	CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: "600000",
} as const;

/**
 * Build the base `env` object for a Claude SDK session.
 *
 * Overlays the full parent `process.env` so HOME (and other inherited vars) are
 * available to tools that depend on them — GPG-signed commits, `gh` CLI auth,
 * etc. claude-agent-sdk v0.2.113 reverted to no longer overlaying process.env
 * itself, so we must do it here. Then applies the shared Cyrus session flags
 * on top. Callers can spread additional vars on top (e.g., repository .env
 * for live runs).
 */
export function buildBaseSessionEnv(
	extra?: Record<string, string>,
): Record<string, string> {
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
	};

	// Forward PATH
	if (process.env.PATH) {
		env.PATH = process.env.PATH;
	}

	// Forward auth credentials from the parent process — the SDK needs these
	// for API calls. See: https://code.claude.com/docs/en/env-vars
	for (const key of AUTH_ENV_KEYS) {
		if (process.env[key]) {
			env[key] = process.env[key];
		}
	}

	return {
		...env,
		...CYRUS_SESSION_ENV,
		...extra,
	};
}

/**
 * Normalize MCP server configs loaded from JSON files.
 *
 * Config files (.mcp.json, mcp-*.json) often omit the `type` field,
 * but the SDK requires an explicit discriminator for non-stdio transports.
 * If a config has a `url` but no `type`, set `type = "http"`.
 *
 * Mutates the input records in place.
 */
export function normalizeMcpHttpTransport(
	servers: Record<string, Record<string, unknown>>,
): void {
	for (const cfg of Object.values(servers)) {
		if (!cfg.type && typeof cfg.url === "string") {
			cfg.type = "http";
		}
	}
}
