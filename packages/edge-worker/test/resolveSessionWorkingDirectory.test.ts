/**
 * Tests for resolveSessionWorkingDirectory.
 *
 * Determines the agent runner's `workingDirectory` (cwd) for a session.
 * Single-repo: `session.workspace.path` IS the worktree → use directly.
 * Multi-repo: `session.workspace.path` is the parent dir of N worktrees;
 * cwd should be the PRIMARY repo's worktree path so the agent has a
 * useful git context (running git commands in the parent of N worktrees
 * doesn't operate on any specific repo).
 */

import { describe, expect, it } from "vitest";
import { resolveSessionWorkingDirectory } from "../src/resolveSessionWorkingDirectory.js";

describe("resolveSessionWorkingDirectory", () => {
	it("returns session.workspace.path for a single-repo session (no repoPaths)", () => {
		const session = {
			workspace: {
				path: "/worktrees/CEE-100/repoA",
				isGitWorktree: true,
			},
		} as any;
		const primaryRepository = {
			id: "repoA",
			repositoryPath: "/src/repoA",
		} as any;

		expect(resolveSessionWorkingDirectory(session, primaryRepository)).toBe(
			"/worktrees/CEE-100/repoA",
		);
	});

	it("returns the primary repo's worktree path for a multi-repo session", () => {
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
		const primaryRepository = {
			id: "repoA",
			repositoryPath: "/src/repoA",
		} as any;

		expect(resolveSessionWorkingDirectory(session, primaryRepository)).toBe(
			"/worktrees/CEE-100/repoA",
		);
	});

	it("falls back to session.workspace.path if primary.id is not present in repoPaths", () => {
		const session = {
			workspace: {
				path: "/worktrees/CEE-100",
				isGitWorktree: true,
				repoPaths: {
					"repoB": "/worktrees/CEE-100/repoB",
				},
			},
		} as any;
		const primaryRepository = {
			id: "repoA",
			repositoryPath: "/src/repoA",
		} as any;

		expect(resolveSessionWorkingDirectory(session, primaryRepository)).toBe(
			"/worktrees/CEE-100",
		);
	});

	it("uses primary's worktree path when primary is the second entry in repoPaths", () => {
		// Order in repoPaths must not affect resolution — it's a key lookup
		const session = {
			workspace: {
				path: "/worktrees/CEE-100",
				isGitWorktree: true,
				repoPaths: {
					"repoB": "/worktrees/CEE-100/repoB",
					repoA: "/worktrees/CEE-100/repoA",
				},
			},
		} as any;
		const primaryRepository = {
			id: "repoA",
			repositoryPath: "/src/repoA",
		} as any;

		expect(resolveSessionWorkingDirectory(session, primaryRepository)).toBe(
			"/worktrees/CEE-100/repoA",
		);
	});
});
