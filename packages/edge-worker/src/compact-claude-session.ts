import { query } from "@anthropic-ai/claude-agent-sdk";
import {
	buildBaseSessionEnv,
	buildHomeDirectoryDisallowedTools,
	type SandboxSettings,
} from "cyrus-claude-runner";
import type { ILogger } from "cyrus-core";

export interface CompactClaudeSessionInput {
	/** The Claude SDK session ID to resume against — the session that owns the transcript to compact. */
	claudeSessionId: string;
	/** Working directory of the session (worktree path). */
	workingDirectory: string;
	/**
	 * Sandbox settings from the very runner config the upcoming real turn will
	 * use, already derived through `buildSessionSandboxSettings`. `undefined`
	 * only when the real turn is itself unsandboxed (no egress sandbox
	 * configured).
	 *
	 * Declared as a REQUIRED key whose value may be `undefined`, not as an
	 * optional key: a caller that forgets it must fail to compile rather than
	 * silently spawn an unconfined session. Same for the two fields below.
	 */
	sandbox: SandboxSettings | undefined;
	/**
	 * Config-level disallowed tool patterns from the same runner config.
	 * Home-directory denials are re-derived here (see `workingDirectory` /
	 * `allowedDirectories`) exactly as `ClaudeRunner` derives them, so the
	 * compact turn's tool-permission posture matches the real turn's.
	 */
	disallowedTools: string[] | undefined;
	/**
	 * Directories the real turn is permitted to read. Used only to carve the
	 * same exceptions out of the home-directory denial set that
	 * `ClaudeRunner` carves, so the two denial lists agree.
	 */
	allowedDirectories: string[] | undefined;
	/**
	 * Env additions applied on top of the base session env. Pass through
	 * the same `additionalEnv` that the issue session subprocess uses
	 * (egress CA cert, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, etc.) so the
	 * compact subprocess behaves identically to the main one.
	 */
	additionalEnv?: Record<string, string>;
	logger: ILogger;
	/** Optional parent abort signal — forwarded to the SDK query. */
	abortSignal?: AbortSignal;
}

export interface CompactClaudeSessionResult {
	/** True if the SDK actually compacted the transcript (a compact boundary was observed). */
	ok: boolean;
	/** SDK error text (from `result` or `errors`) when `ok` is false. */
	error?: string;
	/** Pre-compact token count reported by the SDK, if available. */
	preTokens?: number;
	/** Post-compact token count reported by the SDK, if available. */
	postTokens?: number;
}

/**
 * Invoke a one-shot `/compact` turn against an existing Claude session.
 *
 * This is the executor counterpart to `shouldCompactBeforeTurn`: when the
 * decision function says "yes, compact first," the resume callsite calls
 * this helper to run `/compact` against the same `claudeSessionId` and
 * waits for the SDK's result message before forwarding the user's actual
 * prompt to a fresh runner.
 *
 * Best-effort: when the compact itself fails (e.g. the session is already
 * past 100% and the compact rehydrate hits "Prompt is too long" too), the
 * helper returns `{ ok: false, error }` and the caller can either skip the
 * compact and proceed (the user's prompt will fail the same way) or
 * escalate to the lifeboat (fresh-session-with-summary, deferred).
 *
 * ## Confinement: this is a full Claude Code session, not a bare model call
 *
 * `/compact` is dispatched by spawning a real Claude Code subprocess against
 * the issue worktree. That subprocess must therefore be confined *exactly*
 * as the real turn is, and the caller is required to pass the confinement
 * through from the runner config the real turn will use:
 *
 *   - `sandbox` — without it the compact turn runs OUTSIDE
 *     bubblewrap/seatbelt, so the session's `denyRead: ["~/"]` and
 *     worktree-only `allowWrite` simply do not apply.
 *   - `disallowedTools` (+ the home-directory denials derived below) — the
 *     tool-permission layer's deny list, mirroring `ClaudeRunner`.
 *   - `strictMcpConfig: true` — set unconditionally below. Without it the
 *     subprocess inherits ambient MCP servers from the operator's
 *     `~/.claude.json` and any project `.mcp.json`, which hosted sessions
 *     must never do.
 *   - `settingSources: ["user"]` — deliberately NOT `["user", "project",
 *     "local"]`. A `/compact` turn needs no project or local settings, and
 *     loading them would read the worktree's `.claude/settings.json` and
 *     `.claude/settings.local.json` — including their hooks. `SessionStart`
 *     and `PreCompact` hooks execute shell commands, and the worktree is
 *     checked out from a branch an issue author can influence, so honoring
 *     them here would be repo-content-driven command execution.
 *
 * Note that declining to register MCP servers, hooks or a `canUseTool`
 * callback programmatically does NOT disable the ones loaded via
 * `settingSources` — that is precisely why the setting sources are narrowed
 * rather than relied upon to be inert.
 */
export async function compactClaudeSession(
	input: CompactClaudeSessionInput,
): Promise<CompactClaudeSessionResult> {
	const log = input.logger.withContext({
		sessionId: input.claudeSessionId,
	});

	const abortController = new AbortController();
	const cleanupAbort = input.abortSignal
		? (() => {
				const handler = () => abortController.abort();
				input.abortSignal!.addEventListener("abort", handler);
				return () => input.abortSignal?.removeEventListener("abort", handler);
			})()
		: undefined;

	// Mirror ClaudeRunner: merge the config-level denials with the home
	// directory denials, deduplicating. `Read(~/**)` does not work as a
	// disallowedTools pattern (`~` is never expanded), hence the explicit
	// enumeration helper.
	const disallowedTools = [
		...new Set([
			...(input.disallowedTools ?? []),
			...buildHomeDirectoryDisallowedTools(
				input.workingDirectory,
				input.allowedDirectories ?? [],
			),
		]),
	];

	try {
		const iter = query({
			prompt: "/compact",
			options: {
				resume: input.claudeSessionId,
				cwd: input.workingDirectory,
				abortController,
				env: {
					...buildBaseSessionEnv(),
					...(input.additionalEnv ?? {}),
				},
				systemPrompt: { type: "preset", preset: "claude_code" },
				// See the confinement note above — do NOT widen this to
				// include "project" or "local".
				settingSources: ["user"],
				strictMcpConfig: true,
				...(disallowedTools.length > 0 && { disallowedTools }),
				...(input.sandbox && { sandbox: input.sandbox }),
			},
		});

		// The SDK reports a completed compaction as a distinct
		// SDKCompactBoundaryMessage (`type: "system"`, `subtype:
		// "compact_boundary"`) carrying `compact_metadata` — NOT as a field on
		// the `result` message. Track it as the stream goes by: the result
		// message alone cannot tell us whether anything was actually
		// compacted, and reporting ok on a no-op `/compact` would leave the
		// caller believing an over-budget transcript had been shrunk.
		let compactMetadata:
			| { pre_tokens?: number; post_tokens?: number }
			| undefined;

		for await (const message of iter) {
			if (
				message.type === "system" &&
				"subtype" in message &&
				message.subtype === "compact_boundary"
			) {
				compactMetadata = (message as { compact_metadata?: unknown })
					.compact_metadata as
					| { pre_tokens?: number; post_tokens?: number }
					| undefined;
				continue;
			}
			if (message.type === "result") {
				const isError = "is_error" in message && message.is_error === true;
				if (isError) {
					const errorText =
						"result" in message && typeof message.result === "string"
							? message.result
							: "errors" in message && Array.isArray(message.errors)
								? message.errors.join("; ")
								: "(no error text)";
					log.warn(`/compact returned error result: ${errorText}`);
					return { ok: false, error: errorText };
				}
				if (!compactMetadata) {
					log.warn(
						"/compact completed without a compact boundary — nothing was compacted",
					);
					return {
						ok: false,
						error: "compact completed without a compact boundary",
					};
				}
				log.info(
					`/compact succeeded${
						compactMetadata.pre_tokens !== undefined &&
						compactMetadata.post_tokens !== undefined
							? ` (${compactMetadata.pre_tokens} → ${compactMetadata.post_tokens} tokens)`
							: ""
					}`,
				);
				return {
					ok: true,
					preTokens: compactMetadata.pre_tokens,
					postTokens: compactMetadata.post_tokens,
				};
			}
		}
		return {
			ok: false,
			error: "compact stream closed without a result message",
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.warn(`/compact threw: ${message}`);
		return { ok: false, error: message };
	} finally {
		cleanupAbort?.();
	}
}
