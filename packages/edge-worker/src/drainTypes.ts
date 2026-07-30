// packages/edge-worker/src/drainTypes.ts

export type DrainState = "running" | "draining" | "shutting-down" | "exiting";

export type DrainTrigger = "sigterm" | "uncaught-exception";

export interface PendingToolUse {
	id: string;
	name: string;
	startedAt: number; // epoch ms
}

export interface DrainSessionStatus {
	sessionId: string;
	issueIdentifier?: string;
	pendingToolUses: PendingToolUse[];
	ageMs: number;
	perSessionCapRemainingMs: number;
}

export interface DrainStatus {
	state: DrainState;
	startedAt: number | null;
	hardCapRemainingMs: number | null;
	sessions: DrainSessionStatus[];
}

export type DrainOutcome =
	| { kind: "drained"; durationMs: number; sessionCount: number }
	| {
			kind: "force-killed";
			durationMs: number;
			forcedSessions: ForcedSession[];
	  }
	| {
			kind: "aborted-by-second-signal";
			durationMs: number;
			forcedSessions: ForcedSession[];
	  };

export interface ForcedSession {
	sessionId: string;
	pendingToolUses: PendingToolUse[];
}

export interface DrainConfig {
	hardCapMs: number;
	perSessionCapMs: number;
}

export const DEFAULT_DRAIN_CONFIG: DrainConfig = {
	hardCapMs: 30 * 60 * 1000,
	perSessionCapMs: 20 * 60 * 1000,
};

export function loadDrainConfigFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): DrainConfig {
	const hard = parseIntOr(
		env.CYRUS_DRAIN_HARD_CAP_MS,
		DEFAULT_DRAIN_CONFIG.hardCapMs,
	);
	const per = parseIntOr(
		env.CYRUS_DRAIN_PER_SESSION_CAP_MS,
		DEFAULT_DRAIN_CONFIG.perSessionCapMs,
	);
	return { hardCapMs: hard, perSessionCapMs: per };
}

function parseIntOr(value: string | undefined, fallback: number): number {
	if (value === undefined || value === "") return fallback;
	const n = Number.parseInt(value, 10);
	if (!Number.isFinite(n) || n < 0) return fallback;
	return n;
}
