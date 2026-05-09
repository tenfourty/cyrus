import { describe, expect, it, vi } from "vitest";
import { computeResumeBaseBranchDriftBlocks } from "../src/baseBranchDriftBlocks.js";

function makeSession(overrides: Record<string, unknown> = {}): any {
	return {
		id: "session-1",
		repositories: [{ repositoryId: "repo-a" }],
		workspace: {
			path: "/worktrees/repo-a/ENG-1",
			isGitWorktree: true,
		},
		...overrides,
	};
}

const repoA: any = { id: "repo-a", name: "repo-a", baseBranch: "main" };
const repoB: any = { id: "repo-b", name: "repo-b", baseBranch: "develop" };

describe("computeResumeBaseBranchDriftBlocks", () => {
	it("returns no blocks when single-repo has no drift", async () => {
		const gitService = {
			checkBaseBranchDrift: vi.fn().mockResolvedValue(null),
		};

		const blocks = await computeResumeBaseBranchDriftBlocks({
			session: makeSession(),
			primaryRepo: repoA,
			resolveRepo: (id) => (id === "repo-a" ? repoA : undefined),
			gitService,
		});

		expect(blocks).toEqual([]);
		expect(gitService.checkBaseBranchDrift).toHaveBeenCalledWith(
			"/worktrees/repo-a/ENG-1",
			"main",
		);
	});

	it("returns one block when the single repo's base drifted", async () => {
		const gitService = {
			checkBaseBranchDrift: vi
				.fn()
				.mockResolvedValue({ commitCount: 3, branchName: "main" }),
		};

		const blocks = await computeResumeBaseBranchDriftBlocks({
			session: makeSession(),
			primaryRepo: repoA,
			resolveRepo: (id) => (id === "repo-a" ? repoA : undefined),
			gitService,
		});

		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toContain("<base_branch_update>");
		expect(blocks[0]).toContain("<branch>main</branch>");
		expect(blocks[0]).toContain("<repository>repo-a</repository>");
		expect(blocks[0]).toContain("<commit_count>3</commit_count>");
		expect(blocks[0]).toContain("while this session was dormant");
	});

	it("respects session.workspace.resolvedBaseBranches over repository.baseBranch", async () => {
		const gitService = {
			checkBaseBranchDrift: vi.fn().mockResolvedValue(null),
		};

		await computeResumeBaseBranchDriftBlocks({
			session: makeSession({
				workspace: {
					path: "/worktrees/repo-a/ENG-1",
					isGitWorktree: true,
					resolvedBaseBranches: {
						"repo-a": { branch: "release/2026-q2", source: "default" },
					},
				},
			}),
			primaryRepo: repoA,
			resolveRepo: (id) => (id === "repo-a" ? repoA : undefined),
			gitService,
		});

		expect(gitService.checkBaseBranchDrift).toHaveBeenCalledWith(
			"/worktrees/repo-a/ENG-1",
			"release/2026-q2",
		);
	});

	it("emits one block per drifted repo for multi-repo sessions", async () => {
		const gitService = {
			checkBaseBranchDrift: vi.fn(async (path: string) => {
				if (path === "/worktrees/repo-a/ENG-1") {
					return { commitCount: 4, branchName: "main" };
				}
				if (path === "/worktrees/repo-b/ENG-1") {
					return { commitCount: 2, branchName: "develop" };
				}
				return null;
			}),
		};

		const blocks = await computeResumeBaseBranchDriftBlocks({
			session: makeSession({
				workspace: {
					path: "/worktrees/repo-a/ENG-1",
					isGitWorktree: true,
					repoPaths: {
						"repo-a": "/worktrees/repo-a/ENG-1",
						"repo-b": "/worktrees/repo-b/ENG-1",
					},
				},
			}),
			primaryRepo: repoA,
			resolveRepo: (id) =>
				id === "repo-a" ? repoA : id === "repo-b" ? repoB : undefined,
			gitService,
		});

		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toContain("<repository>repo-a</repository>");
		expect(blocks[0]).toContain("<commit_count>4</commit_count>");
		expect(blocks[1]).toContain("<repository>repo-b</repository>");
		expect(blocks[1]).toContain("<commit_count>2</commit_count>");
	});

	it("emits no block for the clean repo and one block for the drifted sibling in multi-repo", async () => {
		const gitService = {
			checkBaseBranchDrift: vi.fn(async (path: string) => {
				if (path === "/worktrees/repo-a/ENG-1") return null;
				if (path === "/worktrees/repo-b/ENG-1") {
					return { commitCount: 7, branchName: "develop" };
				}
				return null;
			}),
		};

		const blocks = await computeResumeBaseBranchDriftBlocks({
			session: makeSession({
				workspace: {
					path: "/worktrees/repo-a/ENG-1",
					isGitWorktree: true,
					repoPaths: {
						"repo-a": "/worktrees/repo-a/ENG-1",
						"repo-b": "/worktrees/repo-b/ENG-1",
					},
				},
			}),
			primaryRepo: repoA,
			resolveRepo: (id) =>
				id === "repo-a" ? repoA : id === "repo-b" ? repoB : undefined,
			gitService,
		});

		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toContain("<repository>repo-b</repository>");
	});

	it("skips a multi-repo entry whose repository config is missing", async () => {
		const gitService = {
			checkBaseBranchDrift: vi.fn().mockResolvedValue(null),
		};

		await computeResumeBaseBranchDriftBlocks({
			session: makeSession({
				workspace: {
					path: "/worktrees/repo-a/ENG-1",
					isGitWorktree: true,
					repoPaths: {
						"repo-a": "/worktrees/repo-a/ENG-1",
						"repo-missing": "/worktrees/missing",
					},
				},
			}),
			primaryRepo: repoA,
			resolveRepo: (id) => (id === "repo-a" ? repoA : undefined),
			gitService,
		});

		// One call for repo-a; repo-missing skipped silently
		expect(gitService.checkBaseBranchDrift).toHaveBeenCalledTimes(1);
	});

	it("returns no blocks when checkBaseBranchDrift throws (best-effort)", async () => {
		const gitService = {
			checkBaseBranchDrift: vi.fn().mockRejectedValue(new Error("git crash")),
		};

		const blocks = await computeResumeBaseBranchDriftBlocks({
			session: makeSession(),
			primaryRepo: repoA,
			resolveRepo: (id) => (id === "repo-a" ? repoA : undefined),
			gitService,
		});

		expect(blocks).toEqual([]);
	});
});
