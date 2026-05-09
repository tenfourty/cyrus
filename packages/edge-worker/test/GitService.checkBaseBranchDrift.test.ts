import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitService } from "../src/GitService.js";

vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => true),
	mkdirSync: vi.fn(),
	readFileSync: vi.fn(() => ""),
	readdirSync: vi.fn(() => []),
	rmSync: vi.fn(),
	statSync: vi.fn(),
}));

vi.mock("../src/WorktreeIncludeService.js", () => ({
	WorktreeIncludeService: vi.fn().mockImplementation(() => ({
		copyIgnoredFiles: vi.fn().mockResolvedValue(undefined),
	})),
}));

void existsSync;
void mkdirSync;
void readdirSync;
void readFileSync;
void rmSync;
void statSync;

const mockExecSync = vi.mocked(execSync);

/**
 * Build a deterministic git command router for tests.
 *
 * The new resume-time drift algorithm answers "is this worktree's branch
 * behind origin/<base>?" rather than "did this exact fetch advance
 * origin/<base>?" — so the fetch delta is irrelevant, and parallel cyrus
 * traffic that already warmed origin/<base> in the bare repo no longer
 * silences the check. Tests model the worktree's HEAD, the fork point
 * (merge-base HEAD origin/<base>), and the upstream tip directly.
 */
function gitMock(state: {
	fetchOk?: boolean;
	mergeBase?: string | null;
	upstreamTip?: string | null;
	behindCount?: number | null;
}) {
	const fetchOk = state.fetchOk ?? true;
	mockExecSync.mockImplementation((cmd: any) => {
		const c = String(cmd);
		if (c.includes("fetch origin")) {
			if (!fetchOk) throw new Error("network down");
			return "" as any;
		}
		if (c.includes("rev-parse") && c.includes("refs/remotes/origin/")) {
			if (state.upstreamTip == null) {
				throw new Error("fatal: ambiguous argument: unknown revision");
			}
			return `${state.upstreamTip}\n` as any;
		}
		if (c.includes("merge-base")) {
			if (state.mergeBase == null) {
				throw new Error("fatal: no merge base");
			}
			return `${state.mergeBase}\n` as any;
		}
		if (c.includes("rev-list --count")) {
			if (state.behindCount == null) {
				throw new Error("fatal: bad revision");
			}
			return `${state.behindCount}\n` as any;
		}
		throw new Error(`unexpected git command: ${c}`);
	});
}

describe("GitService.checkBaseBranchDrift", () => {
	let gitService: GitService;
	const mockLogger: any = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		withContext: vi.fn().mockReturnThis(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		gitService = new GitService({ cyrusHome: "/home/user/.cyrus" }, mockLogger);
	});

	it("returns null when the worktree branch is already at the upstream tip (behind=0)", async () => {
		gitMock({
			mergeBase: "tip-sha",
			upstreamTip: "tip-sha",
			behindCount: 0,
		});

		const result = await gitService.checkBaseBranchDrift(
			"/worktree/path",
			"main",
		);

		expect(result).toBeNull();
	});

	it("returns drift info with the behind-count when origin/<base> is ahead of the worktree branch", async () => {
		gitMock({
			mergeBase: "fork-sha",
			upstreamTip: "tip-sha",
			behindCount: 9,
		});

		const result = await gitService.checkBaseBranchDrift(
			"/worktree/path",
			"main",
		);

		expect(result).toEqual({ commitCount: 9, branchName: "main" });
	});

	it("reports drift even when the bare repo's origin/<base> ref was already current before the fetch", async () => {
		// Reproduces the cove-agent VM scenario: parallel cyrus traffic keeps
		// origin/main warm in the bare repo, so the fetch is a no-op. The
		// worktree branch is still 9 commits behind because it was created
		// from main 9 commits ago.
		gitMock({
			mergeBase: "fork-sha",
			upstreamTip: "tip-sha",
			behindCount: 9,
		});

		const result = await gitService.checkBaseBranchDrift(
			"/worktree/path",
			"main",
		);

		expect(result).toEqual({ commitCount: 9, branchName: "main" });
	});

	it("returns null for a freshly-created branch born exactly at origin/<base> tip", async () => {
		gitMock({
			mergeBase: "tip-sha",
			upstreamTip: "tip-sha",
			behindCount: 0,
		});

		const result = await gitService.checkBaseBranchDrift(
			"/worktree/path",
			"main",
		);

		expect(result).toBeNull();
	});

	it("returns null when origin/<base> is missing (branch deleted upstream)", async () => {
		gitMock({
			mergeBase: null,
			upstreamTip: null,
		});

		const result = await gitService.checkBaseBranchDrift(
			"/worktree/path",
			"main",
		);

		expect(result).toBeNull();
	});

	it("returns null when merge-base fails (no shared history)", async () => {
		gitMock({
			mergeBase: null,
			upstreamTip: "tip-sha",
		});

		const result = await gitService.checkBaseBranchDrift(
			"/worktree/path",
			"main",
		);

		expect(result).toBeNull();
	});

	it("returns null and logs a warning when fetch fails", async () => {
		gitMock({ fetchOk: false });

		const result = await gitService.checkBaseBranchDrift(
			"/worktree/path",
			"main",
		);

		expect(result).toBeNull();
		expect(mockLogger.warn).toHaveBeenCalled();
	});

	it("returns the behind count only (not symmetric difference) when worktree is also ahead of base", async () => {
		// Diverged: branch has its own commits AND base has new commits.
		// rev-list --count <fork>..origin/<base> reports only the behind
		// side, which is exactly what we want — the agent is told how many
		// upstream commits it hasn't seen, not the symmetric distance.
		gitMock({
			mergeBase: "fork-sha",
			upstreamTip: "tip-sha",
			behindCount: 4,
		});

		const result = await gitService.checkBaseBranchDrift(
			"/worktree/path",
			"main",
		);

		expect(result).toEqual({ commitCount: 4, branchName: "main" });
	});

	it("issues fetch, rev-parse, merge-base, and rev-list against the configured base branch (not hardcoded main)", async () => {
		const calls: string[] = [];
		mockExecSync.mockImplementation((cmd: any) => {
			const c = String(cmd);
			calls.push(c);
			if (c.includes("fetch origin")) return "" as any;
			if (c.includes("rev-parse")) return "tip-sha\n" as any;
			if (c.includes("merge-base")) return "fork-sha\n" as any;
			if (c.includes("rev-list --count")) return "2\n" as any;
			throw new Error(`unexpected: ${c}`);
		});

		await gitService.checkBaseBranchDrift("/worktree/path", "develop");

		expect(
			calls.some((c) => c.includes("fetch origin") && c.includes("develop")),
		).toBe(true);
		expect(
			calls.some(
				(c) =>
					c.includes("rev-parse") && c.includes("refs/remotes/origin/develop"),
			),
		).toBe(true);
		expect(
			calls.some(
				(c) =>
					c.includes("merge-base") && c.includes("refs/remotes/origin/develop"),
			),
		).toBe(true);
	});
});
