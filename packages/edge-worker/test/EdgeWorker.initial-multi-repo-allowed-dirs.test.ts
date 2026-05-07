/**
 * Regression test for the initial-session allowedDirectories assembly.
 *
 * `EdgeWorker.createCyrusAgentSession` builds the `allowedDirectories`
 * list passed to the agent runner SDK at session-creation time. This is
 * a SEPARATE code path from `resumeAgentSession` (which the multi-repo
 * patch already covered via `composeAllowedDirectoriesForSession`).
 *
 * Bug: the initial-creation path used `repo.repositoryPath` (the canonical
 * source clone) for every repo and called `getGitMetadataDirectories`
 * once with `workspace.path`. For a multi-repo session, `workspace.path`
 * is the parent directory of N worktrees and is NOT a git repo, so the
 * call returns nothing — and the actual worktree paths under
 * `session.workspace.repoPaths` were never added. The agent could see
 * the canonical clones but NOT the per-session worktrees, breaking
 * Read/Edit on sibling worktree files.
 *
 * Test asserts the assembly produces ALL worktree paths from
 * `session.workspace.repoPaths` plus per-worktree git metadata for
 * a multi-repo session.
 */

import type { CyrusAgentSession, RepositoryConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { composeInitialAllowedDirectories } from "../src/composeInitialAllowedDirectories.js";

describe("composeInitialAllowedDirectories — multi-repo regression", () => {
	it("includes ALL worktree paths from session.workspace.repoPaths plus all repo source paths", () => {
		const primary = {
			id: "primary-id",
			repositoryPath: "/src/primary",
		} as RepositoryConfig;
		const secondary = {
			id: "secondary-id",
			repositoryPath: "/src/secondary",
		} as RepositoryConfig;

		const session = {
			workspace: {
				path: "/worktrees/CEE-100",
				isGitWorktree: true,
				repoPaths: {
					"primary-id": "/worktrees/CEE-100/primary",
					"secondary-id": "/worktrees/CEE-100/secondary",
				},
			},
		} as CyrusAgentSession;

		const result = composeInitialAllowedDirectories({
			session,
			repositories: [primary, secondary],
			attachmentsDir: "/cyrus-home/CEE-100/attachments",
			getGitMetadataDirectories: (path) => {
				if (path === "/worktrees/CEE-100/primary") return ["/wt/primary/.git"];
				if (path === "/worktrees/CEE-100/secondary")
					return ["/wt/secondary/.git"];
				return [];
			},
		});

		// Every worktree path must be present
		expect(result).toContain("/worktrees/CEE-100/primary");
		expect(result).toContain("/worktrees/CEE-100/secondary");
		// Every repo source path must be present (so canonical clones remain readable)
		expect(result).toContain("/src/primary");
		expect(result).toContain("/src/secondary");
		// Attachments dir
		expect(result).toContain("/cyrus-home/CEE-100/attachments");
		// Per-worktree git metadata
		expect(result).toContain("/wt/primary/.git");
		expect(result).toContain("/wt/secondary/.git");
	});

	it("falls back to single-repo behavior when session.workspace.repoPaths is absent", () => {
		const repo = {
			id: "solo-id",
			repositoryPath: "/src/solo",
		} as RepositoryConfig;

		const session = {
			workspace: {
				path: "/worktrees/CEE-101/solo",
				isGitWorktree: true,
			},
		} as CyrusAgentSession;

		const result = composeInitialAllowedDirectories({
			session,
			repositories: [repo],
			attachmentsDir: "/cyrus-home/CEE-101/attachments",
			getGitMetadataDirectories: (path) => {
				if (path === "/worktrees/CEE-101/solo") return ["/wt/solo/.git"];
				return [];
			},
		});

		expect(result).toContain("/src/solo");
		expect(result).toContain("/cyrus-home/CEE-101/attachments");
		expect(result).toContain("/wt/solo/.git");
		// Single-repo: workspace.path IS the worktree (implicit cwd), not added
		// explicitly to allowedDirectories
		expect(result.length).toBe(3);
	});

	it("deduplicates entries when secondary source path coincides with worktree path", () => {
		const repo = {
			id: "id-1",
			repositoryPath: "/worktrees/CEE-200/foo",
		} as RepositoryConfig;
		const session = {
			workspace: {
				path: "/worktrees/CEE-200",
				isGitWorktree: true,
				repoPaths: {
					"id-1": "/worktrees/CEE-200/foo",
				},
			},
		} as CyrusAgentSession;

		const result = composeInitialAllowedDirectories({
			session,
			repositories: [repo],
			attachmentsDir: "/cyrus-home/CEE-200/attachments",
			getGitMetadataDirectories: () => [],
		});

		const occurrences = result.filter(
			(p) => p === "/worktrees/CEE-200/foo",
		).length;
		expect(occurrences).toBe(1);
	});

	it("forwards extra additionalAllowedDirectories alongside secondary source paths", () => {
		const repoA = {
			id: "repoA-id",
			repositoryPath: "/src/repoA",
		} as RepositoryConfig;
		const coveOvh = {
			id: "repoB-id",
			repositoryPath: "/src/repoB",
		} as RepositoryConfig;

		const session = {
			workspace: {
				path: "/worktrees/CEE-300",
				isGitWorktree: true,
				repoPaths: {
					"repoA-id": "/worktrees/CEE-300/repoA",
					"repoB-id": "/worktrees/CEE-300/repoB",
				},
			},
		} as CyrusAgentSession;

		const result = composeInitialAllowedDirectories({
			session,
			repositories: [repoA, coveOvh],
			attachmentsDir: "/cyrus-home/CEE-300/attachments",
			additionalAllowedDirectories: ["/extra/parent-feedback-dir"],
			getGitMetadataDirectories: () => [],
		});

		// Both secondary canonical AND extra additional get into the result
		expect(result).toContain("/src/repoB");
		expect(result).toContain("/extra/parent-feedback-dir");
		expect(result).toContain("/src/repoA");
		expect(result).toContain("/worktrees/CEE-300/repoA");
		expect(result).toContain("/worktrees/CEE-300/repoB");
	});
});
