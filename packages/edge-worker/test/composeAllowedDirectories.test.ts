/**
 * Tests for composeAllowedDirectoriesForSession.
 *
 * The helper composes the `allowedDirectories` list passed to the agent
 * runner SDK when a session is resumed. For multi-repo sessions, it must
 * include EVERY worktree path in `session.workspace.repoPaths` — not just
 * the primary repo's source path.
 */

import { describe, expect, it } from "vitest";
import { composeAllowedDirectoriesForSession } from "../src/composeAllowedDirectories.js";

describe("composeAllowedDirectoriesForSession", () => {
	it("includes attachments dir, primary repo source path, and primary worktree git metadata for a single-repo session", () => {
		const primaryRepository = {
			id: "repoA",
			repositoryPath: "/src/repoA",
		} as any;

		const session = {
			workspace: {
				path: "/worktrees/CEE-100/repoA",
				isGitWorktree: true,
				// repoPaths absent → single-repo mode
			},
		} as any;

		const result = composeAllowedDirectoriesForSession({
			session,
			primaryRepository,
			attachmentsDir: "/cyrus-home/CEE-100/attachments",
			additionalAllowedDirectories: [],
			getGitMetadataDirectories: (path) => {
				if (path === "/worktrees/CEE-100/repoA") {
					return [
						"/worktrees/CEE-100/repoA/.git",
						"/src/repoA/.git/worktrees/CEE-100",
					];
				}
				return [];
			},
		});

		expect(result.sort()).toEqual(
			[
				"/cyrus-home/CEE-100/attachments",
				"/src/repoA",
				"/worktrees/CEE-100/repoA/.git",
				"/src/repoA/.git/worktrees/CEE-100",
			].sort(),
		);
	});

	it("includes ALL worktree paths from session.workspace.repoPaths in a multi-repo session", () => {
		const primaryRepository = {
			id: "repoA",
			repositoryPath: "/src/repoA",
		} as any;

		const session = {
			workspace: {
				path: "/worktrees/CEE-100",
				isGitWorktree: true,
				repoPaths: {
					repoA: "/worktrees/CEE-100/repoA",
					"repoB": "/worktrees/CEE-100/repoB",
				},
			},
		} as any;

		const result = composeAllowedDirectoriesForSession({
			session,
			primaryRepository,
			attachmentsDir: "/cyrus-home/CEE-100/attachments",
			additionalAllowedDirectories: [],
			getGitMetadataDirectories: () => [], // ignore git metadata for this test
		});

		expect(result).toContain("/worktrees/CEE-100/repoA");
		expect(result).toContain("/worktrees/CEE-100/repoB");
		expect(result).toContain("/cyrus-home/CEE-100/attachments");
	});

	it("merges additionalAllowedDirectories into the result", () => {
		const primaryRepository = {
			id: "repoA",
			repositoryPath: "/src/repoA",
		} as any;

		const session = {
			workspace: {
				path: "/worktrees/CEE-100/repoA",
				isGitWorktree: true,
			},
		} as any;

		const result = composeAllowedDirectoriesForSession({
			session,
			primaryRepository,
			attachmentsDir: "/cyrus-home/CEE-100/attachments",
			additionalAllowedDirectories: ["/extra/dir-1", "/extra/dir-2"],
			getGitMetadataDirectories: () => [],
		});

		expect(result).toContain("/extra/dir-1");
		expect(result).toContain("/extra/dir-2");
	});

	it("deduplicates entries", () => {
		const primaryRepository = {
			id: "repoA",
			repositoryPath: "/src/repoA",
		} as any;

		const session = {
			workspace: {
				path: "/worktrees/CEE-100/repoA",
				isGitWorktree: true,
				repoPaths: {
					repoA: "/worktrees/CEE-100/repoA",
				},
			},
		} as any;

		const result = composeAllowedDirectoriesForSession({
			session,
			primaryRepository,
			attachmentsDir: "/worktrees/CEE-100/repoA", // intentional collision
			additionalAllowedDirectories: ["/worktrees/CEE-100/repoA"],
			getGitMetadataDirectories: () => [],
		});

		const occurrences = result.filter(
			(p) => p === "/worktrees/CEE-100/repoA",
		).length;
		expect(occurrences).toBe(1);
	});

	it("collects git metadata directories for EACH worktree in a multi-repo session", () => {
		const primaryRepository = {
			id: "repoA",
			repositoryPath: "/src/repoA",
		} as any;

		const session = {
			workspace: {
				path: "/worktrees/CEE-100",
				isGitWorktree: true,
				repoPaths: {
					repoA: "/worktrees/CEE-100/repoA",
					"repoB": "/worktrees/CEE-100/repoB",
				},
			},
		} as any;

		const calls: string[] = [];
		const result = composeAllowedDirectoriesForSession({
			session,
			primaryRepository,
			attachmentsDir: "/cyrus-home/CEE-100/attachments",
			additionalAllowedDirectories: [],
			getGitMetadataDirectories: (path) => {
				calls.push(path);
				return [`${path}/.git`];
			},
		});

		// Should call getGitMetadataDirectories for each worktree path
		expect(calls).toContain("/worktrees/CEE-100/repoA");
		expect(calls).toContain("/worktrees/CEE-100/repoB");
		// Both worktrees' git metadata dirs should appear in result
		expect(result).toContain("/worktrees/CEE-100/repoA/.git");
		expect(result).toContain("/worktrees/CEE-100/repoB/.git");
	});
});
