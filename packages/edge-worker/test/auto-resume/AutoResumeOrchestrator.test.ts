import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoResumeOrchestrator } from "../../src/auto-resume/AutoResumeOrchestrator.js";
import { HoldLabelFilter } from "../../src/auto-resume/filters/HoldLabelFilter.js";
import { IssueStateFilter } from "../../src/auto-resume/filters/IssueStateFilter.js";
import { RepositoryOptInFilter } from "../../src/auto-resume/filters/RepositoryOptInFilter.js";
import { RunnerTypeFilter } from "../../src/auto-resume/filters/RunnerTypeFilter.js";
import { StalenessFilter } from "../../src/auto-resume/filters/StalenessFilter.js";
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
	holdLabel: "cyrus:hold",
};

function makeFilters() {
	return [
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
			workspace: { path: tmpRoot, isGitWorktree: true },
		});
		const sessionB = makeSession({
			id: "sess-b",
			workspace: { path: tmpRoot, isGitWorktree: true },
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
				workspace: { path: tmpRoot, isGitWorktree: true },
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
			workspace: { path: tmpRoot, isGitWorktree: true },
		});
		const sessionB = makeSession({
			id: "sess-b",
			workspace: { path: tmpRoot, isGitWorktree: true },
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

	it("treats fetchIssueState errors as inability to verify and skips the session", async () => {
		const session = makeSession({
			workspace: { path: tmpRoot, isGitWorktree: true },
		});
		const resume = vi.fn();

		const orchestrator = new AutoResumeOrchestrator({
			sessions: () => [session],
			repositoryFor: () => ({ autoResumeOnStartup: true }) as any,
			fetchIssueState: async () => {
				throw new Error("Linear API down");
			},
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
				workspace: { path: tmpRoot, isGitWorktree: true },
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
});
