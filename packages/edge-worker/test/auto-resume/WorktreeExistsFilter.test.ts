import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorktreeExistsFilter } from "../../src/auto-resume/filters/WorktreeExistsFilter.js";
import type { ResumeFilterContext } from "../../src/auto-resume/types.js";

const ctx: ResumeFilterContext = {
	now: Date.now(),
	config: { concurrency: 2, staggerMs: [0, 0], maxAgeMs: 0, holdLabel: "" },
	repository: { autoResumeOnStartup: true } as any,
};

function session(
	workspacePath: string,
	repoPaths?: Record<string, string>,
): any {
	return {
		id: "s1",
		workspace: { path: workspacePath, isGitWorktree: true, repoPaths },
	};
}

describe("WorktreeExistsFilter", () => {
	const filter = new WorktreeExistsFilter();
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "cyrus-wt-test-"));
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("admits sessions whose workspace.path exists on disk", () => {
		expect(filter.evaluate(session(tmpRoot), ctx)).toBeNull();
	});

	it("skips sessions whose workspace.path is missing", () => {
		expect(filter.evaluate(session(join(tmpRoot, "nope")), ctx)).toBe(
			"worktree-missing",
		);
	});

	it("skips multi-repo sessions when any sibling repoPath is missing", () => {
		const repoPaths = {
			"repo-a": tmpRoot,
			"repo-b": join(tmpRoot, "missing-sibling"),
		};
		expect(filter.evaluate(session(tmpRoot, repoPaths), ctx)).toBe(
			"worktree-missing",
		);
	});

	it("admits multi-repo sessions when every repoPath exists", () => {
		const repoPaths = { "repo-a": tmpRoot, "repo-b": tmpRoot };
		expect(filter.evaluate(session(tmpRoot, repoPaths), ctx)).toBeNull();
	});
});
