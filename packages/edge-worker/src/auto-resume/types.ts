import type { CyrusAgentSession, RepositoryConfig } from "cyrus-core";

export type SkipReason =
	| "runner-not-supported"
	| "repo-opt-out"
	| "stale"
	| "worktree-missing"
	| "issue-state-changed"
	| "issue-state-unavailable"
	| "hold-label"
	| "status-not-active"
	| "user-stopped"
	| "attempt-budget-exhausted"
	| "duplicate-worktree"
	| "shutting-down";

export interface AutoResumeConfig {
	concurrency: number;
	/** [minMs, maxMs] inclusive range for jitter applied between resume starts. */
	staggerMs: [number, number];
	maxAgeMs: number;
	/**
	 * Consecutive failed resume attempts a session gets before auto-resume
	 * gives up on it. `0` disables the budget.
	 */
	maxAttempts: number;
	holdLabel: string;
}

export interface IssueStateSnapshot {
	stateType?: string;
	labels: string[];
}

export interface ResumeFilterContext {
	now: number;
	config: AutoResumeConfig;
	repository: RepositoryConfig | undefined;
	issueState?: IssueStateSnapshot;
}

export interface ResumeFilter {
	readonly name: string;
	/**
	 * Whether this filter consults `ctx.issueState`. The orchestrator runs
	 * cheap filters (no I/O) first and only fetches the Linear issue snapshot
	 * for survivors that have at least one issue-aware filter to satisfy.
	 */
	readonly requiresIssueState: boolean;
	evaluate(
		session: CyrusAgentSession,
		ctx: ResumeFilterContext,
	): SkipReason | null;
}
