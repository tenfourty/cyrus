import { describe, expect, it } from "vitest";
import { formatBaseBranchUpdate } from "../src/baseBranchUpdate.js";

describe("formatBaseBranchUpdate", () => {
	it("renders the full block when given a webhook-style input (branch, repo, count, compareUrl, commits)", () => {
		const block = formatBaseBranchUpdate({
			branchName: "main",
			repository: "owner/repo",
			commitCount: 3,
			compareUrl: "https://github.com/owner/repo/compare/abc...def",
			commits: ["fix: a", "feat: b", "chore: c"],
		});

		expect(block).toBe(`<base_branch_update>
<branch>main</branch>
<repository>owner/repo</repository>
<commit_count>3</commit_count>
<compare_url>https://github.com/owner/repo/compare/abc...def</compare_url>
<commits>
- fix: a
- feat: b
- chore: c
</commits>
<guidance>
Your base branch \`main\` has received 3 new commit(s). Consider rebasing your working branch onto the updated base to avoid merge conflicts. You can do this with: \`git fetch origin && git rebase origin/main\`
</guidance>
</base_branch_update>`);
	});

	it("truncates the commit list to 5 with a 'and N more' line when more than 5 commits", () => {
		const block = formatBaseBranchUpdate({
			branchName: "main",
			repository: "owner/repo",
			commitCount: 8,
			compareUrl: "https://github.com/owner/repo/compare/abc...def",
			commits: [
				"fix: a",
				"feat: b",
				"chore: c",
				"docs: d",
				"refactor: e",
				"test: f",
				"build: g",
				"ci: h",
			],
		});

		expect(block).toContain(
			"- fix: a\n- feat: b\n- chore: c\n- docs: d\n- refactor: e",
		);
		expect(block).toContain("- ... and 3 more");
		expect(block).not.toContain("- test: f");
	});

	it("omits compare_url and commits tags when not provided (resume-time use)", () => {
		const block = formatBaseBranchUpdate({
			branchName: "main",
			repository: "owner/repo",
			commitCount: 4,
		});

		expect(block).toBe(`<base_branch_update>
<branch>main</branch>
<repository>owner/repo</repository>
<commit_count>4</commit_count>
<guidance>
Your base branch \`main\` has received 4 new commit(s) while this session was dormant. Consider rebasing your working branch onto the updated base to avoid merge conflicts. You can do this with: \`git fetch origin && git rebase origin/main\`
</guidance>
</base_branch_update>`);
	});

	it("uses the live-traffic guidance when compareUrl is provided", () => {
		const block = formatBaseBranchUpdate({
			branchName: "main",
			repository: "owner/repo",
			commitCount: 1,
			compareUrl: "https://github.com/owner/repo/compare/abc...def",
			commits: ["fix: a"],
		});

		expect(block).toContain("has received 1 new commit(s).");
		expect(block).not.toContain("while this session was dormant");
	});
});
