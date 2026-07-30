import type { CyrusAgentSession, ILogger, RepositoryConfig } from "cyrus-core";
import { Semaphore } from "./Semaphore.js";
import type {
	AutoResumeConfig,
	IssueStateSnapshot,
	ResumeFilter,
	ResumeFilterContext,
	SkipReason,
} from "./types.js";

export interface AutoResumeOrchestratorDeps {
	/** Returns the active sessions to consider for auto-resume. */
	sessions: () => CyrusAgentSession[];
	/** Resolves a session's primary repository config (or undefined if missing). */
	repositoryFor: (session: CyrusAgentSession) => RepositoryConfig | undefined;
	/**
	 * Pre-flight fetch of the Linear issue state. Resolves to undefined for
	 * sessions without an associated issue. Errors should be thrown so the
	 * orchestrator can record them and skip conservatively.
	 */
	fetchIssueState: (issueId: string) => Promise<IssueStateSnapshot | undefined>;
	/**
	 * Records that a resume is about to be attempted, so a session that can
	 * never be resumed eventually exhausts its budget instead of being
	 * retried on every boot. Called immediately before `resumeSession`.
	 */
	recordResumeAttempt?: (session: CyrusAgentSession) => void;
	/** Clears the consecutive-failure counter after a successful resume. */
	clearResumeAttempts?: (session: CyrusAgentSession) => void;
	/**
	 * Cooperative cancellation. Polled before each preflight and before each
	 * resume so a shutdown that lands mid-drain does not keep spawning
	 * runners the process is about to orphan.
	 */
	shouldAbort?: () => boolean;
	/** Spawns a fresh runner for the session via the existing resume path. */
	resumeSession: (session: CyrusAgentSession) => Promise<void>;
	/** Posts a "resumed after restart" activity. Best-effort. */
	notifyResumed: (session: CyrusAgentSession) => Promise<void>;
	/** Posts a "session retired" activity. Best-effort UX hook. */
	notifyRetired: (
		session: CyrusAgentSession,
		reason: SkipReason,
	) => Promise<void>;
	/**
	 * Remove the session from in-memory + persisted state. Called for skip
	 * reasons that should permanently discard the session (currently only
	 * `worktree-missing`). Separate from `notifyRetired` so notification
	 * failures (e.g. cross-platform validation errors) do NOT leave the
	 * session record stuck in state — the orphan would otherwise resurface
	 * at every restart and re-fire the same notification error.
	 */
	retireSession: (
		session: CyrusAgentSession,
		reason: SkipReason,
	) => Promise<void>;
	logger: ILogger;
	config: AutoResumeConfig;
	filters: ResumeFilter[];
	/** Injectable for tests. Defaults to setTimeout-based sleep. */
	sleep?: (ms: number) => Promise<void>;
	/** Injectable for tests. Defaults to Math.random. */
	random?: () => number;
}

export interface AutoResumeRunSummary {
	resumed: string[];
	skipped: Array<{ sessionId: string; reason: SkipReason }>;
	failed: Array<{ sessionId: string; error: Error }>;
}

const NOTIFY_RETIRED_REASONS: ReadonlySet<SkipReason> = new Set([
	"worktree-missing",
]);

/**
 * Identity for "these two sessions would fight over the same working copy".
 *
 * Worktree paths are the thing that actually gets corrupted by two
 * concurrent agents, so they are the primary key (sorted, so multi-repo
 * sessions listing the same set in a different order still collide). Issue
 * id is the fallback, because a worktree is derived from the issue and a
 * session missing workspace paths still shares the issue's thread. Session
 * id last, which never collides — a session with neither is unique by
 * construction.
 */
export function dedupKeyFor(session: CyrusAgentSession): string {
	const repoPaths = session.workspace?.repoPaths;
	if (repoPaths) {
		const paths = Object.values(repoPaths).filter(Boolean).sort();
		if (paths.length > 0) return `worktree:${paths.join("|")}`;
	}
	const path = session.workspace?.path;
	if (path) return `worktree:${path}`;
	const issueId = session.issueContext?.issueId ?? session.issueId;
	if (issueId) return `issue:${issueId}`;
	return `session:${session.id}`;
}

/**
 * Walks persisted active sessions at startup, applies a filter pipeline to
 * decide which should be respawned, and drains survivors through a
 * concurrency-capped queue with jitter. Pre-flight is split into cheap
 * synchronous filters (no I/O) followed by a single Linear fetch and
 * remaining filters that depend on the issue snapshot.
 */
export class AutoResumeOrchestrator {
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly random: () => number;

	constructor(private readonly deps: AutoResumeOrchestratorDeps) {
		this.sleep =
			deps.sleep ??
			((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.random = deps.random ?? Math.random;
	}

	async run(): Promise<AutoResumeRunSummary> {
		const summary: AutoResumeRunSummary = {
			resumed: [],
			skipped: [],
			failed: [],
		};

		const sessions = this.deps.sessions();
		const survivors: CyrusAgentSession[] = [];
		// Worktree/issue keys already claimed by an admitted session this run.
		// Two Active sessions on one issue is a real persisted state, and both
		// would otherwise get a runner in the same worktree at once — exactly
		// the concurrent-agent corruption we avoid at the webhook layer.
		const claimedKeys = new Map<string, string>();

		for (const session of sessions) {
			if (this.aborted()) {
				summary.skipped.push({
					sessionId: session.id,
					reason: "shutting-down",
				});
				continue;
			}
			const result = await this.preflight(session);
			if (result !== null) {
				summary.skipped.push({ sessionId: session.id, reason: result });
				if (NOTIFY_RETIRED_REASONS.has(result)) {
					await this.safeNotifyRetired(session, result);
					await this.safeRetireSession(session, result);
				}
				continue;
			}

			const key = dedupKeyFor(session);
			const claimedBy = claimedKeys.get(key);
			if (claimedBy !== undefined) {
				this.deps.logger.warn(
					`Auto-resume: session ${session.id} shares workspace/issue "${key}" with already-admitted session ${claimedBy}; skipping to avoid two agents in one worktree`,
				);
				summary.skipped.push({
					sessionId: session.id,
					reason: "duplicate-worktree",
				});
				continue;
			}
			claimedKeys.set(key, session.id);
			survivors.push(session);
		}

		const semaphore = new Semaphore(this.deps.config.concurrency);
		await Promise.all(
			survivors.map((session) =>
				semaphore.run(async () => {
					await this.applyJitter();
					if (this.aborted()) {
						summary.skipped.push({
							sessionId: session.id,
							reason: "shutting-down",
						});
						return;
					}
					// Count the attempt BEFORE trying. A resume that throws every
					// time (deleted issue, permanently broken workspace) must
					// still burn budget, otherwise it is retried on every boot
					// forever — `updatedAt`-based staleness cannot catch it
					// because resuming refreshes `updatedAt`.
					this.deps.recordResumeAttempt?.(session);
					try {
						await this.deps.resumeSession(session);
						summary.resumed.push(session.id);
						this.deps.clearResumeAttempts?.(session);
						await this.safeNotifyResumed(session);
					} catch (error) {
						const err =
							error instanceof Error ? error : new Error(String(error));
						summary.failed.push({ sessionId: session.id, error: err });
						const attempts = session.autoResumeAttempts ?? 0;
						const max = this.deps.config.maxAttempts;
						const budgetNote =
							max > 0
								? attempts >= max
									? ` — attempt budget exhausted (${attempts}/${max}), this session will not be auto-resumed again unless it is re-prompted`
									: ` — attempt ${attempts}/${max}`
								: "";
						this.deps.logger.error(
							`Auto-resume failed for session ${session.id}${budgetNote}`,
							err,
						);
					}
				}),
			),
		);

		return summary;
	}

	private aborted(): boolean {
		return this.deps.shouldAbort?.() === true;
	}

	private async preflight(
		session: CyrusAgentSession,
	): Promise<SkipReason | null> {
		const repository = this.deps.repositoryFor(session);
		const baseCtx: ResumeFilterContext = {
			now: Date.now(),
			config: this.deps.config,
			repository,
		};

		const cheapFilters = this.deps.filters.filter((f) => !f.requiresIssueState);
		const issueAwareFilters = this.deps.filters.filter(
			(f) => f.requiresIssueState,
		);

		for (const filter of cheapFilters) {
			const reason = filter.evaluate(session, baseCtx);
			if (reason !== null) return reason;
		}

		if (issueAwareFilters.length === 0) return null;

		const issueId = session.issueContext?.issueId ?? session.issueId;
		let issueState: IssueStateSnapshot | undefined;
		if (issueId) {
			try {
				issueState = await this.deps.fetchIssueState(issueId);
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error));
				// A tracker outage is not the same thing as "the issue was
				// closed". Reporting both as `issue-state-changed` made a
				// transient 5xx at boot look like a deliberate operator action
				// in the journal, while silently disabling the whole feature
				// for that run. Retry once, then report honestly under its own
				// reason so the count is visibly an infrastructure problem.
				this.deps.logger.warn(
					`Auto-resume could not verify issue state for ${session.id} (${issueId}); retrying once: ${err.message}`,
				);
				try {
					issueState = await this.deps.fetchIssueState(issueId);
				} catch (retryError) {
					const retryErr =
						retryError instanceof Error
							? retryError
							: new Error(String(retryError));
					this.deps.logger.warn(
						`Auto-resume still could not verify issue state for ${session.id} (${issueId}) after a retry; skipping conservatively (issue tracker unavailable, NOT an issue state change): ${retryErr.message}`,
					);
					return "issue-state-unavailable";
				}
			}
		}

		const issueCtx: ResumeFilterContext = { ...baseCtx, issueState };
		for (const filter of issueAwareFilters) {
			const reason = filter.evaluate(session, issueCtx);
			if (reason !== null) return reason;
		}

		return null;
	}

	private async applyJitter(): Promise<void> {
		const [minMs, maxMs] = this.deps.config.staggerMs;
		if (maxMs <= 0) return;
		const span = Math.max(0, maxMs - minMs);
		const wait = minMs + Math.floor(this.random() * (span + 1));
		if (wait > 0) await this.sleep(wait);
	}

	private async safeNotifyResumed(session: CyrusAgentSession): Promise<void> {
		try {
			await this.deps.notifyResumed(session);
		} catch (error) {
			this.deps.logger.warn(
				`Auto-resume notifyResumed failed for ${session.id}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	private async safeNotifyRetired(
		session: CyrusAgentSession,
		reason: SkipReason,
	): Promise<void> {
		try {
			await this.deps.notifyRetired(session, reason);
		} catch (error) {
			this.deps.logger.warn(
				`Auto-resume notifyRetired failed for ${session.id}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	private async safeRetireSession(
		session: CyrusAgentSession,
		reason: SkipReason,
	): Promise<void> {
		try {
			await this.deps.retireSession(session, reason);
		} catch (error) {
			this.deps.logger.warn(
				`Auto-resume retireSession failed for ${session.id}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
}
