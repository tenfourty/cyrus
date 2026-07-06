/**
 * Pure helpers for the stall watchdog.
 *
 * These are intentionally free of timers, side effects, and imports from
 * ClaudeRunner — the watchdog wiring (timers, event listeners) is a
 * separate task that consumes these building blocks. Keeping the logic
 * pure here makes it fully unit-testable in isolation.
 */

export interface StallConfig {
	enabled: boolean;
	idleMs: number; // model-idle budget (no tool in flight)
	toolMs: number; // tool-in-flight budget
}

/**
 * Pick which inactivity budget applies: the (longer) tool-in-flight budget
 * when a tool is currently running, otherwise the (shorter) model-idle
 * budget.
 */
export function selectStallBudget(
	pendingToolCount: number,
	cfg: { idleMs: number; toolMs: number },
): number {
	return pendingToolCount > 0 ? cfg.toolMs : cfg.idleMs;
}

/**
 * Compute how a single SDK message changes the in-flight tool count.
 *
 * Mirrors the content-block shape `ClaudeRunner.processMessage` uses:
 * `message.type` is `"assistant"` or `"user"`, and `message.message.content`
 * is an array of blocks each with a `.type` (`"tool_use"`, `"tool_result"`,
 * `"text"`, etc).
 *
 * - assistant message: +1 per `tool_use` block (a turn can request several
 *   tools at once).
 * - user message: -1 per `tool_result` block (tool results are echoed back
 *   as user messages).
 * - anything else, or malformed/missing content: 0. Never throws.
 */
export function pendingToolDelta(message: unknown): number {
	const msg = message as
		| { type?: unknown; message?: { content?: unknown } }
		| null
		| undefined;

	if (msg?.type === "assistant") {
		const content = msg.message?.content;
		if (!Array.isArray(content)) return 0;
		let count = 0;
		for (const block of content) {
			if ((block as { type?: unknown })?.type === "tool_use") count++;
		}
		return count;
	}

	if (msg?.type === "user") {
		const content = msg.message?.content;
		if (!Array.isArray(content)) return 0;
		let count = 0;
		for (const block of content) {
			if ((block as { type?: unknown })?.type === "tool_result") count++;
		}
		return -count;
	}

	return 0;
}

/**
 * Resolve watchdog config from env, mirroring the CYRUS_WARM_INSTANCE_TTL_MS
 * parse pattern in EdgeWorker.ts: `Number.parseInt(x ?? "", 10)`, accept
 * only finite values `> 0`, else fall back to the default.
 *
 * Defaults (empirically confirmed via an F1 message-flow observation): a
 * blocking silent tool emitted nothing for ~87s (tool budget is the only
 * net), and the max mid-generation silent gap was ~49s — so 10-min idle /
 * 30-min tool give >12x / ~20x margin.
 */
export function resolveStallConfig(env: NodeJS.ProcessEnv): StallConfig {
	const rawEnabled = env.CYRUS_STALL_WATCHDOG;
	const enabled = rawEnabled !== "0" && rawEnabled !== "false";

	const parsedIdle = Number.parseInt(env.CYRUS_STALL_IDLE_TIMEOUT_MS ?? "", 10);
	const idleMs =
		Number.isFinite(parsedIdle) && parsedIdle > 0 ? parsedIdle : 10 * 60 * 1000; // 10 min default

	const parsedTool = Number.parseInt(env.CYRUS_STALL_TOOL_TIMEOUT_MS ?? "", 10);
	const toolMs =
		Number.isFinite(parsedTool) && parsedTool > 0 ? parsedTool : 30 * 60 * 1000; // 30 min default

	return { enabled, idleMs, toolMs };
}
