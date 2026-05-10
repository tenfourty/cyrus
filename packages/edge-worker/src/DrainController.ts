import type { ILogger } from "cyrus-core";
import type { EventEmitter } from "node:events";
import type {
	DrainConfig,
	DrainOutcome,
	DrainSessionStatus,
	DrainState,
	DrainStatus,
	DrainTrigger,
	ForcedSession,
	PendingToolUse,
} from "./drainTypes.js";

interface AgentSessionManagerLike extends EventEmitter {
	getActiveAttachedSessionIds(): string[];
	getPendingToolUseDetails(sessionId: string): PendingToolUse[];
}

export interface DrainControllerInput {
	agentSessionManager: AgentSessionManagerLike;
	config: DrainConfig;
	logger: ILogger;
}

export class DrainController {
	private _state: DrainState = "running";
	private startedAt: number | null = null;
	private hardCapTimer: ReturnType<typeof setTimeout> | null = null;
	private perSessionTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private resolveOutcome: ((o: DrainOutcome) => void) | null = null;
	private outcomePromise: Promise<DrainOutcome> | null = null;
	private trackedSessions = new Set<string>();
	private aborted = false;

	constructor(private readonly input: DrainControllerInput) {
		if (input.config.hardCapMs > 0 && input.config.perSessionCapMs > input.config.hardCapMs) {
			throw new Error(
				`DrainController: perSessionCapMs (${input.config.perSessionCapMs}) must be <= hardCapMs (${input.config.hardCapMs})`,
			);
		}
	}

	getState(): DrainState {
		return this._state;
	}

	isDraining(): boolean {
		return this._state === "draining" || this._state === "shutting-down";
	}

	beginDrain(trigger: DrainTrigger): Promise<DrainOutcome> {
		// Idempotent: second call returns same Promise
		if (this.outcomePromise) return this.outcomePromise;

		const log = this.input.logger;
		this._state = "draining";
		this.startedAt = Date.now();

		// Disabled drain (hardCapMs=0): immediately force-kill
		if (this.input.config.hardCapMs === 0) {
			log.warn("[DrainController] Drain disabled (hardCapMs=0); proceeding to immediate force-kill outcome");
			const forced = this.snapshotForced();
			this._state = "shutting-down";
			this.outcomePromise = Promise.resolve({
				kind: "force-killed" as const,
				durationMs: 0,
				forcedSessions: forced,
			});
			return this.outcomePromise;
		}

		log.info(`[DrainController] Drain started (trigger=${trigger}, hardCapMs=${this.input.config.hardCapMs})`);

		this.outcomePromise = new Promise<DrainOutcome>((resolve) => {
			this.resolveOutcome = resolve;
		});

		// Snapshot active sessions at drain start
		this.trackedSessions = new Set(this.input.agentSessionManager.getActiveAttachedSessionIds());

		// Arm per-session timers
		for (const sid of this.trackedSessions) {
			this.armPerSessionTimer(sid);
		}

		// Subscribe to lifecycle events
		this.input.agentSessionManager.on("session_terminal", this.onSessionTerminal);
		this.input.agentSessionManager.on("tool_use_completed", this.onToolUseCompleted);

		// Arm hard cap timer
		this.hardCapTimer = setTimeout(() => this.onHardCapExpired(), this.input.config.hardCapMs);

		// Initial evaluation — may already be drainable (e.g. no sessions)
		this.evaluate();

		return this.outcomePromise;
	}

	abortDrain(): void {
		if (this._state !== "draining") return;
		this.aborted = true;
		this.input.logger.warn("[DrainController] Drain aborted by second signal — proceeding to immediate shutdown");
		const forced = this.snapshotForced();
		this.cleanup();
		this._state = "shutting-down";
		this.resolveOutcome?.({
			kind: "aborted-by-second-signal",
			durationMs: this.elapsedMs(),
			forcedSessions: forced,
		});
	}

	getStatus(): DrainStatus {
		const now = Date.now();
		const sessions: DrainSessionStatus[] = [];

		for (const sid of this.trackedSessions) {
			const pending = this.input.agentSessionManager.getPendingToolUseDetails(sid);
			const ageMs = this.startedAt ? now - this.startedAt : 0;
			const perSessionRemaining = this.startedAt
				? Math.max(0, this.input.config.perSessionCapMs - (now - this.startedAt))
				: this.input.config.perSessionCapMs;

			sessions.push({
				sessionId: sid,
				pendingToolUses: pending,
				ageMs,
				perSessionCapRemainingMs: perSessionRemaining,
			});
		}

		return {
			state: this._state,
			startedAt: this.startedAt,
			hardCapRemainingMs:
				this.startedAt !== null
					? Math.max(0, this.input.config.hardCapMs - this.elapsedMs())
					: null,
			sessions,
		};
	}

	// ── Event handlers ────────────────────────────────────────────────────────

	private onSessionTerminal = (ev: { sessionId: string }) => {
		if (!this.trackedSessions.has(ev.sessionId)) return;
		this.markSessionDone(ev.sessionId);
	};

	private onToolUseCompleted = (_ev: { sessionId: string; toolUseId: string; isError: boolean }) => {
		this.evaluate();
	};

	// ── Internal helpers ──────────────────────────────────────────────────────

	private armPerSessionTimer(sessionId: string): void {
		if (this.input.config.perSessionCapMs === 0) return;
		const t = setTimeout(() => {
			this.input.logger.warn(
				`[DrainController] Per-session cap (${this.input.config.perSessionCapMs}ms) hit for session ${sessionId}; treating as drainable`,
			);
			this.markSessionDone(sessionId);
		}, this.input.config.perSessionCapMs);
		this.perSessionTimers.set(sessionId, t);
	}

	private markSessionDone(sessionId: string): void {
		this.trackedSessions.delete(sessionId);
		const t = this.perSessionTimers.get(sessionId);
		if (t !== undefined) {
			clearTimeout(t);
			this.perSessionTimers.delete(sessionId);
		}
		this.evaluate();
	}

	private evaluate(): void {
		if (this.aborted || this._state !== "draining") return;

		// Check if all tracked sessions have empty pending tool-use sets
		let allEmpty = true;
		for (const sid of this.trackedSessions) {
			if (this.input.agentSessionManager.getPendingToolUseDetails(sid).length > 0) {
				allEmpty = false;
				break;
			}
		}

		if (this.trackedSessions.size === 0 || allEmpty) {
			const sessionCount = this.trackedSessions.size;
			this.cleanup();
			this._state = "shutting-down";
			this.resolveOutcome?.({
				kind: "drained",
				durationMs: this.elapsedMs(),
				sessionCount,
			});
		}
	}

	private onHardCapExpired(): void {
		this.input.logger.error(
			`[DrainController] Hard cap (${this.input.config.hardCapMs}ms) hit during drain — force-killing remaining sessions`,
		);
		const forced = this.snapshotForced();
		this.cleanup();
		this._state = "shutting-down";
		this.resolveOutcome?.({
			kind: "force-killed",
			durationMs: this.elapsedMs(),
			forcedSessions: forced,
		});
	}

	private snapshotForced(): ForcedSession[] {
		const out: ForcedSession[] = [];
		for (const sid of this.trackedSessions) {
			const pending = this.input.agentSessionManager.getPendingToolUseDetails(sid);
			if (pending.length > 0) {
				out.push({ sessionId: sid, pendingToolUses: pending });
			}
		}
		return out;
	}

	private elapsedMs(): number {
		return this.startedAt !== null ? Date.now() - this.startedAt : 0;
	}

	private cleanup(): void {
		this.input.agentSessionManager.off("session_terminal", this.onSessionTerminal);
		this.input.agentSessionManager.off("tool_use_completed", this.onToolUseCompleted);

		if (this.hardCapTimer !== null) {
			clearTimeout(this.hardCapTimer);
			this.hardCapTimer = null;
		}

		for (const t of this.perSessionTimers.values()) {
			clearTimeout(t);
		}
		this.perSessionTimers.clear();
	}
}
