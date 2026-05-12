import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildBaseSessionEnv } from "cyrus-claude-runner";
import type { ILogger } from "cyrus-core";

export interface CompactClaudeSessionInput {
	/** The Claude SDK session ID to resume against — the session that owns the transcript to compact. */
	claudeSessionId: string;
	/** Working directory of the session (worktree path). */
	workingDirectory: string;
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
	/** True if the SDK emitted a successful result message. */
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
 * The compact turn uses the same session env as the main runner — auth
 * tokens, CA certs, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` if set — so it
 * inherits the operator's network and compaction config. It does NOT
 * register MCP servers, hooks, or canUseTool callbacks — the slash command
 * doesn't invoke any tools, just the SDK summarization model call.
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
				return () =>
					input.abortSignal?.removeEventListener("abort", handler);
			})()
		: undefined;

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
				settingSources: ["user", "project", "local"],
			},
		});

		for await (const message of iter) {
			if (message.type === "result") {
				const isError =
					"is_error" in message && message.is_error === true;
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
				const metadata = (message as { compact_metadata?: unknown })
					.compact_metadata as
					| { pre_tokens?: number; post_tokens?: number }
					| undefined;
				log.info(
					`/compact succeeded${
						metadata?.pre_tokens !== undefined &&
						metadata?.post_tokens !== undefined
							? ` (${metadata.pre_tokens} → ${metadata.post_tokens} tokens)`
							: ""
					}`,
				);
				return {
					ok: true,
					preTokens: metadata?.pre_tokens,
					postTokens: metadata?.post_tokens,
				};
			}
		}
		return { ok: false, error: "compact stream closed without a result message" };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.warn(`/compact threw: ${message}`);
		return { ok: false, error: message };
	} finally {
		cleanupAbort?.();
	}
}
