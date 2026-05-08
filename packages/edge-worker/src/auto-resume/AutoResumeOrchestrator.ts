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
	/** Spawns a fresh runner for the session via the existing resume path. */
	resumeSession: (session: CyrusAgentSession) => Promise<void>;
	/** Posts a "resumed after restart" activity. Best-effort. */
	notifyResumed: (session: CyrusAgentSession) => Promise<void>;
	/** Posts a "session retired" activity. Best-effort. */
	notifyRetired: (
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

		for (const session of sessions) {
			const result = await this.preflight(session);
			if (result === null) {
				survivors.push(session);
				continue;
			}
			summary.skipped.push({ sessionId: session.id, reason: result });
			if (NOTIFY_RETIRED_REASONS.has(result)) {
				await this.safeNotifyRetired(session, result);
			}
		}

		const semaphore = new Semaphore(this.deps.config.concurrency);
		await Promise.all(
			survivors.map((session) =>
				semaphore.run(async () => {
					await this.applyJitter();
					try {
						await this.deps.resumeSession(session);
						summary.resumed.push(session.id);
						await this.safeNotifyResumed(session);
					} catch (error) {
						const err =
							error instanceof Error ? error : new Error(String(error));
						summary.failed.push({ sessionId: session.id, error: err });
						this.deps.logger.error(
							`Auto-resume failed for session ${session.id}`,
							err,
						);
					}
				}),
			),
		);

		return summary;
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
				this.deps.logger.warn(
					`Auto-resume could not verify issue state for ${session.id} (${issueId}); skipping conservatively: ${err.message}`,
				);
				return "issue-state-changed";
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
}
