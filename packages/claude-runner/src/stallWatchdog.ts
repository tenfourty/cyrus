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

/**
 * Tool-aware inactivity watchdog for a single ClaudeRunner's ACTIVE TURN.
 *
 * This is a self-contained timer state machine — no ClaudeRunner import —
 * built from the pure helpers above (`selectStallBudget`, `pendingToolDelta`).
 * ClaudeRunner wires it at a handful of seams (turn start/end, message
 * handling, teardown); all timer/budget logic lives here so it stays
 * unit-testable in isolation with fake timers.
 *
 * Load-bearing invariant: the watchdog only ever ticks while `turnActive` is
 * true. A warm runner sits silent between turns for an unbounded time (the
 * `result` message is emitted but the SDK loop stays open for a possible
 * follow-up prompt) — resetting/arming outside an active turn would
 * false-positive on that healthy idle window. `onMessage` is a no-op unless
 * a turn is active, and the `result` message ends the turn rather than
 * re-arming it.
 */
export class StallWatchdog {
	private turnActive = false;
	private pendingToolCount = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly cfg: StallConfig, // { enabled, idleMs, toolMs }
		private readonly onStall: (info: {
			budgetMs: number;
			pendingToolCount: number;
		}) => void, // called when a turn goes silent past budget
	) {}

	/** Turn started (fresh turn or a warm follow-up prompt): mark active, reset tool count, arm. */
	beginTurn(): void {
		if (!this.cfg.enabled) return;
		// A streamed follow-up can arrive MID-turn (Cyrus mid-implementation
		// prompting streams a user comment into a live turn). Only zero the
		// in-flight tool count for a genuinely new turn (prior turn ended →
		// turnActive false); mid-turn, preserve pendingToolCount so a tool still
		// in flight keeps the longer tool budget instead of being downgraded to
		// the idle budget.
		if (!this.turnActive) {
			this.turnActive = true;
			this.pendingToolCount = 0;
		}
		this.arm();
	}

	/** An SDK message arrived. While the turn is active: update tool-in-flight count; on `result`
	 *  end the turn (disarm, no re-arm); otherwise re-arm with the current budget. */
	onMessage(message: unknown): void {
		if (!this.cfg.enabled || !this.turnActive) return;
		this.pendingToolCount = Math.max(
			0,
			this.pendingToolCount + pendingToolDelta(message),
		);
		if ((message as { type?: unknown } | null | undefined)?.type === "result") {
			this.endTurn();
		} else {
			this.arm();
		}
	}

	/** Turn ended (result / stop / interrupt): disarm and go inactive. */
	endTurn(): void {
		this.turnActive = false;
		this.pendingToolCount = 0;
		this.disarm();
	}

	/** Runner teardown — ensure no dangling timer. */
	dispose(): void {
		this.disarm();
	}

	private arm(): void {
		this.disarm();
		if (!this.cfg.enabled || !this.turnActive) return;
		const budgetMs = selectStallBudget(this.pendingToolCount, this.cfg);
		const pendingToolCount = this.pendingToolCount;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.onStall({ budgetMs, pendingToolCount });
		}, budgetMs);
		this.timer.unref?.();
	}

	private disarm(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}
}
