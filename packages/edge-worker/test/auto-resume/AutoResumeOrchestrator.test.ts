import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoResumeOrchestrator } from "../../src/auto-resume/AutoResumeOrchestrator.js";
import { AttemptBudgetFilter } from "../../src/auto-resume/filters/AttemptBudgetFilter.js";
import { HoldLabelFilter } from "../../src/auto-resume/filters/HoldLabelFilter.js";
import { IssueStateFilter } from "../../src/auto-resume/filters/IssueStateFilter.js";
import { RepositoryOptInFilter } from "../../src/auto-resume/filters/RepositoryOptInFilter.js";
import { RunnerTypeFilter } from "../../src/auto-resume/filters/RunnerTypeFilter.js";
import { StalenessFilter } from "../../src/auto-resume/filters/StalenessFilter.js";
import { StatusActiveFilter } from "../../src/auto-resume/filters/StatusActiveFilter.js";
import { StopIntentFilter } from "../../src/auto-resume/filters/StopIntentFilter.js";
import { WorktreeExistsFilter } from "../../src/auto-resume/filters/WorktreeExistsFilter.js";
import type {
	AutoResumeConfig,
	IssueStateSnapshot,
} from "../../src/auto-resume/types.js";

function makeSession(overrides: Record<string, unknown> = {}): any {
	const now = Date.now();
	return {
		id: "session-1",
		status: "active",
		createdAt: now,
		updatedAt: now,
		issueContext: {
			issueId: "issue-1",
			issueIdentifier: "TEST-1",
			trackerId: "linear",
		},
		repositories: [{ repositoryId: "repo-a" }],
		workspace: { path: "/tmp/does-not-matter", isGitWorktree: true },
		...overrides,
	};
}

const defaultConfig: AutoResumeConfig = {
	concurrency: 2,
	staggerMs: [0, 0],
	maxAgeMs: 7 * 24 * 3600 * 1000,
	maxAttempts: 3,
	holdLabel: "cyrus:hold",
};

function makeFilters() {
	// Mirrors the pipeline EdgeWorker installs, so these tests exercise the
	// same admission rules production does.
	return [
		new StatusActiveFilter(),
		new StopIntentFilter(),
		new AttemptBudgetFilter(),
		new RunnerTypeFilter(),
		new RepositoryOptInFilter(),
		new StalenessFilter(),
		new WorktreeExistsFilter(),
		new IssueStateFilter(),
		new HoldLabelFilter(),
	];
}

describe("AutoResumeOrchestrator", () => {
	let tmpRoot: string;

	/**
	 * A distinct existing worktree path. Sessions that are meant to be
	 * independent must not share one: the orchestrator now dedups by
	 * worktree, so reusing a path would (correctly) collapse them.
	 */
	function worktree(name: string): string {
		const path = join(tmpRoot, name);
		mkdirSync(path, { recursive: true });
		return path;
	}

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "cyrus-orch-test-"));
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("resumes sessions that pass every filter", async () => {
		const session = makeSession({
			workspace: { path: tmpRoot, isGitWorktree: true },
		});
		const resume = vi.fn().mockResolvedValue(undefined);

		const orchestrator = new AutoResumeOrchestrator({
			sessions: () => [session],
			repositoryFor: () => ({ autoResumeOnStartup: true }) as any,
			fetchIssueState: async () =>
				({ stateType: "started", labels: [] }) satisfies IssueStateSnapshot,
			resumeSession: resume,
			notifyResumed: async () => {},
			notifyRetired: async () => {},
			logger: console as any,
			config: defaultConfig,
			filters: makeFilters(),
			sleep: async () => {},
			random: () => 0,
		});

		const summary = await orchestrator.run();

		expect(resume).toHaveBeenCalledOnce();
		expect(resume).toHaveBeenCalledWith(session);
		expect(summary.resumed).toEqual(["session-1"]);
		expect(summary.skipped).toEqual([]);
		expect(summary.failed).toEqual([]);
	});

	it("skips sessions when the repository is opted out", async () => {
		const session = makeSession({
			workspace: { path: tmpRoot, isGitWorktree: true },
		});
		const resume = vi.fn();

		const orchestrator = new AutoResumeOrchestrator({
			sessions: () => [session],
			repositoryFor: () => ({ autoResumeOnStartup: false }) as any,
			fetchIssueState: async () => ({ stateType: "started", labels: [] }),
			resumeSession: resume,
			notifyResumed: async () => {},
			notifyRetired: async () => {},
			logger: console as any,
			config: defaultConfig,
			filters: makeFilters(),
			sleep: async () => {},
			random: () => 0,
		});

		const summary = await orchestrator.run();

		expect(resume).not.toHaveBeenCalled();
		expect(summary.skipped).toEqual([
			{ sessionId: "session-1", reason: "repo-opt-out" },
		]);
	});

	it("does not fetch issue state when a cheap filter has already rejected", async () => {
		const session = makeSession({
			workspace: { path: tmpRoot, isGitWorktree: true },
		});
		const fetchIssueState = vi.fn();

		const orchestrator = new AutoResumeOrchestrator({
			sessions: () => [session],
			repositoryFor: () => ({ autoResumeOnStartup: false }) as any,
			fetchIssueState,
			resumeSession: async () => {},
			notifyResumed: async () => {},
			notifyRetired: async () => {},
			logger: console as any,
			config: defaultConfig,
			filters: makeFilters(),
			sleep: async () => {},
			random: () => 0,
		});

		await orchestrator.run();

		expect(fetchIssueState).not.toHaveBeenCalled();
	});

	it("skips sessions whose issue moved to completed during downtime", async () => {
		const session = makeSession({
			workspace: { path: tmpRoot, isGitWorktree: true },
		});
		const resume = vi.fn();

		const orchestrator = new AutoResumeOrchestrator({
			sessions: () => [session],
			repositoryFor: () => ({ autoResumeOnStartup: true }) as any,
			fetchIssueState: async () => ({ stateType: "completed", labels: [] }),
			resumeSession: resume,
			notifyResumed: async () => {},
			notifyRetired: async () => {},
			logger: console as any,
			config: defaultConfig,
			filters: makeFilters(),
			sleep: async () => {},
			random: () => 0,
		});

		const summary = await orchestrator.run();

		expect(resume).not.toHaveBeenCalled();
		expect(summary.skipped).toEqual([
			{ sessionId: "session-1", reason: "issue-state-changed" },
		]);
	});

	it("skips sessions whose issue carries the hold label", async () => {
		const session = makeSession({
			workspace: { path: tmpRoot, isGitWorktree: true },
		});
		const resume = vi.fn();

		const orchestrator = new AutoResumeOrchestrator({
			sessions: () => [session],
			repositoryFor: () => ({ autoResumeOnStartup: true }) as any,
			fetchIssueState: async () => ({
				stateType: "started",
				labels: ["cyrus:hold"],
			}),
			resumeSession: resume,
			notifyResumed: async () => {},
			notifyRetired: async () => {},
			logger: console as any,
			config: defaultConfig,
			filters: makeFilters(),
			sleep: async () => {},
			random: () => 0,
		});

		const summary = await orchestrator.run();

		expect(resume).not.toHaveBeenCalled();
		expect(summary.skipped).toEqual([
			{ sessionId: "session-1", reason: "hold-label" },
		]);
	});

	it("calls notifyRetired only when the worktree is missing", async () => {
		const sessionMissingWorktree = makeSession({
			id: "missing",
			workspace: { path: join(tmpRoot, "gone"), isGitWorktree: true },
		});
		const sessionHeld = makeSession({
			id: "held",
			workspace: { path: tmpRoot, isGitWorktree: true },
		});
		const sessionOK = makeSession({
			id: "ok",
			workspace: { path: tmpRoot, isGitWorktree: true },
		});

		const notifyRetired = vi.fn().mockResolvedValue(undefined);
		const fetchIssueState = vi.fn(async (issueId: string) => {
			if (issueId === "issue-held")
				return { stateType: "started", labels: ["cyrus:hold"] };
			return { stateType: "started", labels: [] };
		});

		const orchestrator = new AutoResumeOrchestrator({
			sessions: () => [
				sessionMissingWorktree,
				{
					...sessionHeld,
					issueContext: {
						issueId: "issue-held",
						issueIdentifier: "TEST-2",
						trackerId: "linear",
					},
				},
				sessionOK,
			],
			repositoryFor: () => ({ autoResumeOnStartup: true }) as any,
			fetchIssueState,
			resumeSession: async () => {},
			notifyResumed: async () => {},
			notifyRetired,
			logger: console as any,
			config: defaultConfig,
			filters: makeFilters(),
			sleep: async () => {},
			random: () => 0,
		});

		await orchestrator.run();

		expect(notifyRetired).toHaveBeenCalledOnce();
		expect(notifyRetired).toHaveBeenCalledWith(
			sessionMissingWorktree,
			"worktree-missing",
		);
	});

	it("calls notifyResumed for each session that gets respawned", async () => {
		const sessionA = makeSession({
			id: "sess-a",
			workspace: { path: worktree("a"), isGitWorktree: true },
		});
		const sessionB = makeSession({
			id: "sess-b",
			workspace: { path: worktree("b"), isGitWorktree: true },
		});

		const notifyResumed = vi.fn().mockResolvedValue(undefined);

		const orchestrator = new AutoResumeOrchestrator({
			sessions: () => [sessionA, sessionB],
			repositoryFor: () => ({ autoResumeOnStartup: true }) as any,
			fetchIssueState: async () => ({ stateType: "started", labels: [] }),
			resumeSession: async () => {},
			notifyResumed,
			notifyRetired: async () => {},
			logger: console as any,
			config: defaultConfig,
			filters: makeFilters(),
			sleep: async () => {},
			random: () => 0,
		});

		await orchestrator.run();

		expect(notifyResumed).toHaveBeenCalledTimes(2);
	});

	it("caps concurrent resumeSession calls at config.concurrency", async () => {
		const sessions = Array.from({ length: 5 }, (_, i) =>
			makeSession({
				id: `s-${i}`,
				workspace: { path: worktree(`s-${i}`), isGitWorktree: true },
			}),
		);

		let active = 0;
		let peak = 0;
		const resume = vi.fn(async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 5));
			active--;
		});

		const orchestrator = new AutoResumeOrchestrator({
			sessions: () => sessions,
			repositoryFor: () => ({ autoResumeOnStartup: true }) as any,
			fetchIssueState: async () => ({ stateType: "started", labels: [] }),
			resumeSession: resume,
			notifyResumed: async () => {},
			notifyRetired: async () => {},
			logger: console as any,
			config: { ...defaultConfig, concurrency: 2 },
			filters: makeFilters(),
			sleep: async () => {},
			random: () => 0,
		});

		await orchestrator.run();

		expect(peak).toBe(2);
		expect(resume).toHaveBeenCalledTimes(5);
	});

	it("records resumeSession failures and continues with remaining sessions", async () => {
		const sessionA = makeSession({
			id: "sess-a",
			workspace: { path: worktree("a"), isGitWorktree: true },
		});
		const sessionB = makeSession({
			id: "sess-b",
			workspace: { path: worktree("b"), isGitWorktree: true },
		});

		const resume = vi
			.fn()
			.mockImplementationOnce(async () => {
				throw new Error("spawn failed");
			})
			.mockResolvedValueOnce(undefined);

		const orchestrator = new AutoResumeOrchestrator({
			sessions: () => [sessionA, sessionB],
			repositoryFor: () => ({ autoResumeOnStartup: true }) as any,
			fetchIssueState: async () => ({ stateType: "started", labels: [] }),
			resumeSession: resume,
			notifyResumed: async () => {},
			notifyRetired: async () => {},
			logger: console as any,
			config: defaultConfig,
			filters: makeFilters(),
			sleep: async () => {},
			random: () => 0,
		});

		const summary = await orchestrator.run();

		expect(resume).toHaveBeenCalledTimes(2);
		expect(summary.resumed).toEqual(["sess-b"]);
		expect(summary.failed).toHaveLength(1);
		expect(summary.failed[0].sessionId).toBe("sess-a");
	});

	it("reports a persistently unreachable issue tracker as issue-state-unavailable, not as an issue state change", async () => {
		const session = makeSession({
			workspace: { path: tmpRoot, isGitWorktree: true },
		});
		const resume = vi.fn();
		const fetchIssueState = vi.fn(async () => {
			throw new Error("Linear API down");
		});

		const orchestrator = new AutoResumeOrchestrator({
			sessions: () => [session],
			repositoryFor: () => ({ autoResumeOnStartup: true }) as any,
			fetchIssueState,
			resumeSession: resume,
			notifyResumed: async () => {},
			notifyRetired: async () => {},
			logger: console as any,
			config: defaultConfig,
			filters: makeFilters(),
			sleep: async () => {},
			random: () => 0,
		});

		const summary = await orchestrator.run();

		expect(resume).not.toHaveBeenCalled();
		// Retried once before giving up.
		expect(fetchIssueState).toHaveBeenCalledTimes(2);
		expect(summary.skipped).toEqual([
			{ sessionId: "session-1", reason: "issue-state-unavailable" },
		]);
	});

	it("retries a transient fetchIssueState failure and admits the session when the retry succeeds", async () => {
		const session = makeSession({
			workspace: { path: tmpRoot, isGitWorktree: true },
		});
		const resume = vi.fn().mockResolvedValue(undefined);
		const fetchIssueState = vi
			.fn()
			.mockRejectedValueOnce(new Error("503 Service Unavailable"))
			.mockResolvedValueOnce({ stateType: "started", labels: [] });

		const orchestrator = new AutoResumeOrchestrator({
			sessions: () => [session],
			repositoryFor: () => ({ autoResumeOnStartup: true }) as any,
			fetchIssueState,
			resumeSession: resume,
			notifyResumed: async () => {},
			notifyRetired: async () => {},
			logger: console as any,
			config: defaultConfig,
			filters: makeFilters(),
			sleep: async () => {},
			random: () => 0,
		});

		const summary = await orchestrator.run();

		expect(fetchIssueState).toHaveBeenCalledTimes(2);
		expect(resume).toHaveBeenCalledOnce();
		expect(summary.resumed).toEqual(["session-1"]);
		expect(summary.skipped).toEqual([]);
	});

	it("admits sessions without an issue (chatbot-style) without fetching issue state", async () => {
		const session = makeSession({
			id: "chatbot",
			workspace: { path: tmpRoot, isGitWorktree: true },
			issueContext: undefined,
			issueId: undefined,
		});
		const fetchIssueState = vi.fn();
		const resume = vi.fn().mockResolvedValue(undefined);

		const orchestrator = new AutoResumeOrchestrator({
			sessions: () => [session],
			repositoryFor: () => ({ autoResumeOnStartup: true }) as any,
			fetchIssueState,
			resumeSession: resume,
			notifyResumed: async () => {},
			notifyRetired: async () => {},
			logger: console as any,
			config: defaultConfig,
			filters: makeFilters(),
			sleep: async () => {},
			random: () => 0,
		});

		const summary = await orchestrator.run();

		expect(fetchIssueState).not.toHaveBeenCalled();
		expect(resume).toHaveBeenCalledOnce();
		expect(summary.resumed).toEqual(["chatbot"]);
	});

	it("applies jitter inside the configured [minMs, maxMs] range between resume starts", async () => {
		const sessions = Array.from({ length: 3 }, (_, i) =>
			makeSession({
				id: `s-${i}`,
				workspace: { path: worktree(`s-${i}`), isGitWorktree: true },
			}),
		);
		const sleepCalls: number[] = [];
		const sleep = vi.fn(async (ms: number) => {
			sleepCalls.push(ms);
		});
		// random() = 0.5 → jitter lands at midpoint of the range
		const random = () => 0.5;

		const orchestrator = new AutoResumeOrchestrator({
			sessions: () => sessions,
			repositoryFor: () => ({ autoResumeOnStartup: true }) as any,
			fetchIssueState: async () => ({ stateType: "started", labels: [] }),
			resumeSession: async () => {},
			notifyResumed: async () => {},
			notifyRetired: async () => {},
			logger: console as any,
			config: { ...defaultConfig, staggerMs: [500, 1500] },
			filters: makeFilters(),
			sleep,
			random,
		});

		await orchestrator.run();

		expect(sleepCalls).toHaveLength(3);
		for (const wait of sleepCalls) {
			expect(wait).toBeGreaterThanOrEqual(500);
			expect(wait).toBeLessThanOrEqual(1500);
		}
	});

	it("skips the jitter sleep entirely when staggerMs is [0, 0]", async () => {
		const session = makeSession({
			workspace: { path: tmpRoot, isGitWorktree: true },
		});
		const sleep = vi.fn();

		const orchestrator = new AutoResumeOrchestrator({
			sessions: () => [session],
			repositoryFor: () => ({ autoResumeOnStartup: true }) as any,
			fetchIssueState: async () => ({ stateType: "started", labels: [] }),
			resumeSession: async () => {},
			notifyResumed: async () => {},
			notifyRetired: async () => {},
			logger: console as any,
			config: { ...defaultConfig, staggerMs: [0, 0] },
			filters: makeFilters(),
			sleep,
			random: () => 0.5,
		});

		await orchestrator.run();

		expect(sleep).not.toHaveBeenCalled();
	});

	it("calls retireSession when worktree is missing — even if notifyRetired throws", async () => {
		// Background: prior to this, the orchestrator only fired the
		// best-effort UX notification (`notifyRetired`) for worktree-missing
		// skips and did NOT remove the session from state. When the
		// notification call threw — e.g. Linear's GraphQL rejected a
		// non-UUID GitLab session id with `agentSessionId must be a UUID` —
		// the orphan stayed in state, surfaced again at every restart,
		// and re-fired the same error indefinitely.
		const session = makeSession({
			workspace: { path: "/tmp/does-not-exist-anywhere", isGitWorktree: true },
		});
		const retireSession = vi.fn().mockResolvedValue(undefined);
		const notifyRetired = vi
			.fn()
			.mockRejectedValue(new Error("agentSessionId must be a UUID"));

		const orchestrator = new AutoResumeOrchestrator({
			sessions: () => [session],
			repositoryFor: () => ({ autoResumeOnStartup: true }) as any,
			fetchIssueState: async () => ({ stateType: "started", labels: [] }),
			resumeSession: async () => {},
			notifyResumed: async () => {},
			notifyRetired,
			retireSession,
			logger: console as any,
			config: defaultConfig,
			filters: makeFilters(),
			sleep: async () => {},
			random: () => 0,
		});

		const summary = await orchestrator.run();

		expect(notifyRetired).toHaveBeenCalledOnce();
		expect(retireSession).toHaveBeenCalledOnce();
		expect(retireSession).toHaveBeenCalledWith(session, "worktree-missing");
		expect(summary.skipped).toEqual([
			{ sessionId: "session-1", reason: "worktree-missing" },
		]);
	});

	it("calls retireSession when retireSession itself throws — failure is logged but does not abort the drain", async () => {
		const session = makeSession({
			workspace: { path: "/tmp/does-not-exist-anywhere", isGitWorktree: true },
		});
		const retireSession = vi
			.fn()
			.mockRejectedValue(new Error("removeSession blew up"));

		const orchestrator = new AutoResumeOrchestrator({
			sessions: () => [session],
			repositoryFor: () => ({ autoResumeOnStartup: true }) as any,
			fetchIssueState: async () => ({ stateType: "started", labels: [] }),
			resumeSession: async () => {},
			notifyResumed: async () => {},
			notifyRetired: async () => {},
			retireSession,
			logger: { ...console, warn: vi.fn() } as any,
			config: defaultConfig,
			filters: makeFilters(),
			sleep: async () => {},
			random: () => 0,
		});

		const summary = await orchestrator.run();
		expect(retireSession).toHaveBeenCalledOnce();
		expect(summary.skipped).toEqual([
			{ sessionId: "session-1", reason: "worktree-missing" },
		]);
	});

	describe("per-worktree dedup", () => {
		it("admits only one of two Active sessions sharing a worktree", async () => {
			// Two Active sessions for one issue is a real persisted state.
			// Without dedup, concurrency >= 2 gives both a runner in the same
			// worktree at the same time.
			const a = makeSession({
				id: "sess-a",
				workspace: { path: tmpRoot, isGitWorktree: true },
			});
			const b = makeSession({
				id: "sess-b",
				workspace: { path: tmpRoot, isGitWorktree: true },
			});
			const resume = vi.fn().mockResolvedValue(undefined);

			const orchestrator = new AutoResumeOrchestrator({
				sessions: () => [a, b],
				repositoryFor: () => ({ autoResumeOnStartup: true }) as any,
				fetchIssueState: async () => ({ stateType: "started", labels: [] }),
				resumeSession: resume,
				notifyResumed: async () => {},
				notifyRetired: async () => {},
				retireSession: async () => {},
				logger: console as any,
				config: defaultConfig,
				filters: makeFilters(),
				sleep: async () => {},
				random: () => 0,
			});

			const summary = await orchestrator.run();

			expect(resume).toHaveBeenCalledOnce();
			expect(resume).toHaveBeenCalledWith(a);
			expect(summary.resumed).toEqual(["sess-a"]);
			expect(summary.skipped).toEqual([
				{ sessionId: "sess-b", reason: "duplicate-worktree" },
			]);
		});

		it("dedups multi-repo sessions listing the same worktree set in a different order", async () => {
			const paths = {
				"repo-a": worktree("multi-a"),
				"repo-b": worktree("multi-b"),
			};

			const a = makeSession({
				id: "sess-a",
				workspace: { path: tmpRoot, isGitWorktree: true, repoPaths: paths },
			});
			const b = makeSession({
				id: "sess-b",
				workspace: {
					path: tmpRoot,
					isGitWorktree: true,
					repoPaths: { "repo-b": paths["repo-b"], "repo-a": paths["repo-a"] },
				},
			});
			const resume = vi.fn().mockResolvedValue(undefined);

			const orchestrator = new AutoResumeOrchestrator({
				sessions: () => [a, b],
				repositoryFor: () => ({ autoResumeOnStartup: true }) as any,
				fetchIssueState: async () => ({ stateType: "started", labels: [] }),
				resumeSession: resume,
				notifyResumed: async () => {},
				notifyRetired: async () => {},
				retireSession: async () => {},
				logger: console as any,
				config: defaultConfig,
				filters: makeFilters(),
				sleep: async () => {},
				random: () => 0,
			});

			const summary = await orchestrator.run();

			expect(resume).toHaveBeenCalledOnce();
			expect(summary.skipped).toEqual([
				{ sessionId: "sess-b", reason: "duplicate-worktree" },
			]);
		});

		it("does not dedup sessions in distinct worktrees", async () => {
			const dirA = worktree("wt-a");
			const dirB = worktree("wt-b");

			const a = makeSession({
				id: "sess-a",
				workspace: { path: dirA, isGitWorktree: true },
			});
			const b = makeSession({
				id: "sess-b",
				issueContext: {
					issueId: "issue-2",
					issueIdentifier: "TEST-2",
					trackerId: "linear",
				},
				workspace: { path: dirB, isGitWorktree: true },
			});
			const resume = vi.fn().mockResolvedValue(undefined);

			const orchestrator = new AutoResumeOrchestrator({
				sessions: () => [a, b],
				repositoryFor: () => ({ autoResumeOnStartup: true }) as any,
				fetchIssueState: async () => ({ stateType: "started", labels: [] }),
				resumeSession: resume,
				notifyResumed: async () => {},
				notifyRetired: async () => {},
				retireSession: async () => {},
				logger: console as any,
				config: defaultConfig,
				filters: makeFilters(),
				sleep: async () => {},
				random: () => 0,
			});

			const summary = await orchestrator.run();

			expect(resume).toHaveBeenCalledTimes(2);
			expect(summary.skipped).toEqual([]);
		});
	});

	describe("attempt budget", () => {
		/**
		 * The deleted-issue loop: the resume path throws every time, and
		 * because resuming refreshes `updatedAt`, the staleness filter can
		 * never age the session out. Only the attempt counter terminates it.
		 */
		it("stops retrying a permanently-failing session after maxAttempts boots", async () => {
			const session = makeSession({
				workspace: { path: tmpRoot, isGitWorktree: true },
			});
			const resume = vi.fn(async () => {
				// Simulate resumeAgentSession's own touch of updatedAt before it
				// throws — this is what defeats StalenessFilter.
				session.updatedAt = Date.now();
				throw new Error("Failed to fetch full issue details for issue-1");
			});

			const boot = () =>
				new AutoResumeOrchestrator({
					sessions: () => [session],
					repositoryFor: () => ({ autoResumeOnStartup: true }) as any,
					fetchIssueState: async () => undefined,
					resumeSession: resume,
					notifyResumed: async () => {},
					notifyRetired: async () => {},
					retireSession: async () => {},
					recordResumeAttempt: (s) => {
						s.autoResumeAttempts = (s.autoResumeAttempts ?? 0) + 1;
					},
					clearResumeAttempts: (s) => {
						s.autoResumeAttempts = undefined;
					},
					logger: console as any,
					config: defaultConfig,
					filters: makeFilters(),
					sleep: async () => {},
					random: () => 0,
				}).run();

			// Boots 1..3 each burn one attempt and fail.
			for (let i = 1; i <= 3; i++) {
				const summary = await boot();
				expect(summary.failed).toHaveLength(1);
				expect(session.autoResumeAttempts).toBe(i);
			}

			// Boot 4 and every boot after it stop touching the session at all.
			const fourth = await boot();
			expect(resume).toHaveBeenCalledTimes(3);
			expect(fourth.failed).toEqual([]);
			expect(fourth.skipped).toEqual([
				{ sessionId: "session-1", reason: "attempt-budget-exhausted" },
			]);

			const fifth = await boot();
			expect(resume).toHaveBeenCalledTimes(3);
			expect(fifth.skipped).toEqual([
				{ sessionId: "session-1", reason: "attempt-budget-exhausted" },
			]);
		});

		it("resets the counter after a successful resume", async () => {
			const session = makeSession({
				workspace: { path: tmpRoot, isGitWorktree: true },
				autoResumeAttempts: 2,
			});
			const resume = vi.fn().mockResolvedValue(undefined);

			const orchestrator = new AutoResumeOrchestrator({
				sessions: () => [session],
				repositoryFor: () => ({ autoResumeOnStartup: true }) as any,
				fetchIssueState: async () => ({ stateType: "started", labels: [] }),
				resumeSession: resume,
				notifyResumed: async () => {},
				notifyRetired: async () => {},
				retireSession: async () => {},
				recordResumeAttempt: (s) => {
					s.autoResumeAttempts = (s.autoResumeAttempts ?? 0) + 1;
				},
				clearResumeAttempts: (s) => {
					s.autoResumeAttempts = undefined;
				},
				logger: console as any,
				config: defaultConfig,
				filters: makeFilters(),
				sleep: async () => {},
				random: () => 0,
			});

			const summary = await orchestrator.run();

			expect(summary.resumed).toEqual(["session-1"]);
			expect(session.autoResumeAttempts).toBeUndefined();
		});

		it("counts the attempt before resuming, so a crash mid-resume still burns budget", async () => {
			const session = makeSession({
				workspace: { path: tmpRoot, isGitWorktree: true },
			});
			let attemptsSeenInsideResume: number | undefined;

			const orchestrator = new AutoResumeOrchestrator({
				sessions: () => [session],
				repositoryFor: () => ({ autoResumeOnStartup: true }) as any,
				fetchIssueState: async () => ({ stateType: "started", labels: [] }),
				resumeSession: async (s) => {
					attemptsSeenInsideResume = s.autoResumeAttempts;
				},
				notifyResumed: async () => {},
				notifyRetired: async () => {},
				retireSession: async () => {},
				recordResumeAttempt: (s) => {
					s.autoResumeAttempts = (s.autoResumeAttempts ?? 0) + 1;
				},
				clearResumeAttempts: (s) => {
					s.autoResumeAttempts = undefined;
				},
				logger: console as any,
				config: defaultConfig,
				filters: makeFilters(),
				sleep: async () => {},
				random: () => 0,
			});

			await orchestrator.run();

			expect(attemptsSeenInsideResume).toBe(1);
		});
	});

	describe("cooperative abort", () => {
		it("stops admitting sessions once shouldAbort flips", async () => {
			const a = makeSession({
				id: "sess-a",
				workspace: { path: worktree("abort-a"), isGitWorktree: true },
			});
			const b = makeSession({
				id: "sess-b",
				issueContext: {
					issueId: "issue-2",
					issueIdentifier: "TEST-2",
					trackerId: "linear",
				},
				workspace: { path: worktree("abort-b"), isGitWorktree: true },
			});
			let aborted = false;
			const resume = vi.fn(async () => {
				// Shutdown lands while the first resume is in flight.
				aborted = true;
			});

			const orchestrator = new AutoResumeOrchestrator({
				sessions: () => [a, b],
				repositoryFor: () => ({ autoResumeOnStartup: true }) as any,
				fetchIssueState: async () => ({ stateType: "started", labels: [] }),
				resumeSession: resume,
				notifyResumed: async () => {},
				notifyRetired: async () => {},
				retireSession: async () => {},
				shouldAbort: () => aborted,
				logger: console as any,
				config: { ...defaultConfig, concurrency: 1 },
				filters: makeFilters(),
				sleep: async () => {},
				random: () => 0,
			});

			const summary = await orchestrator.run();

			expect(resume).toHaveBeenCalledOnce();
			expect(summary.resumed).toEqual(["sess-a"]);
			expect(summary.skipped).toEqual([
				{ sessionId: "sess-b", reason: "shutting-down" },
			]);
		});

		it("skips everything when abort is already set before the drain starts", async () => {
			const session = makeSession({
				workspace: { path: tmpRoot, isGitWorktree: true },
			});
			const resume = vi.fn();

			const orchestrator = new AutoResumeOrchestrator({
				sessions: () => [session],
				repositoryFor: () => ({ autoResumeOnStartup: true }) as any,
				fetchIssueState: async () => ({ stateType: "started", labels: [] }),
				resumeSession: resume,
				notifyResumed: async () => {},
				notifyRetired: async () => {},
				retireSession: async () => {},
				shouldAbort: () => true,
				logger: console as any,
				config: defaultConfig,
				filters: makeFilters(),
				sleep: async () => {},
				random: () => 0,
			});

			const summary = await orchestrator.run();

			expect(resume).not.toHaveBeenCalled();
			expect(summary.skipped).toEqual([
				{ sessionId: "session-1", reason: "shutting-down" },
			]);
		});
	});
});
