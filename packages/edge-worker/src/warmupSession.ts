import type { McpServerConfig } from "cyrus-claude-runner";
import type { CyrusAgentSession, RepositoryConfig } from "cyrus-core";
import { resolveSessionWorkingDirectory } from "./resolveSessionWorkingDirectory.js";

/**
 * Substring of the SDK error raised when a resumed conversation's transcript
 * does not exist where Claude Code looks for it (keyed off cwd). Mirrors the
 * marker ClaudeRunner uses for its live fresh-start fallback.
 */
const NO_CONVERSATION_FOUND_MARKER = "No conversation found with session ID";

export interface WarmupStartupOptions {
	resume: string | undefined;
	model: string;
	cwd: string;
	mcpServers?: Record<string, McpServerConfig>;
	allowedTools?: string[];
	disallowedTools?: string[];
	settingSources: ("user" | "project" | "local")[];
	env: Record<string, string>;
}

/**
 * Build the `options` passed to the SDK's `startup()` when pre-warming a
 * resumable Claude session.
 *
 * The critical field is `cwd`: it MUST match the working directory the live
 * runner uses for this session, because Claude Code derives the transcript
 * store location from cwd. For multi-repo workspaces the live cwd is the
 * primary repo's worktree (a subdir of `workspace.path`), not the workspace
 * root — so warming with the root cwd points at a project slug that has no
 * transcripts and the resume fails with "No conversation found". Using the
 * shared `resolveSessionWorkingDirectory` keeps warmup and the live runner in
 * lockstep.
 */
export function buildWarmupStartupOptions(input: {
	session: CyrusAgentSession;
	repository: RepositoryConfig;
	model: string;
	mcpServers: Record<string, McpServerConfig>;
	allowedTools: string[];
	disallowedTools: string[];
	env: Record<string, string>;
}): WarmupStartupOptions {
	return {
		resume: input.session.claudeSessionId,
		model: input.model,
		cwd: resolveSessionWorkingDirectory(input.session, input.repository),
		...(Object.keys(input.mcpServers).length > 0 && {
			mcpServers: input.mcpServers,
		}),
		...(input.allowedTools.length > 0 && { allowedTools: input.allowedTools }),
		...(input.disallowedTools.length > 0 && {
			disallowedTools: input.disallowedTools,
		}),
		settingSources: ["user", "project", "local"],
		env: input.env,
	};
}

/**
 * Whether an error from `startup()` is the recoverable "the resumed
 * conversation no longer exists" failure. Such a candidate is skipped during
 * pre-warm (counted separately from hard failures); the live runner's
 * fresh-start fallback handles it when the user's prompt actually arrives.
 */
export function isNoConversationFoundError(err: unknown): boolean {
	const message =
		err instanceof Error ? err.message : typeof err === "string" ? err : "";
	return message.includes(NO_CONVERSATION_FOUND_MARKER);
}
