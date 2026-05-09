import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitService } from "../src/GitService.js";

/**
 * Regression tests for command injection via git invocations.
 *
 * A base-branch override parsed out of a `[repo=name#branch]` issue-description
 * tag is untrusted text and reaches `checkBaseBranchDrift` via
 * `baseBranchOverrides` -> `resolvedBaseBranches` -> `resolveBaseBranch`. If git
 * were ever invoked through a shell string (e.g.
 * `execSync(`git fetch origin "${baseBranch}"`)`), a payload containing
 * `$(...)` would execute on the host: double quotes do not prevent command
 * substitution. Git is invoked with an argument vector instead, so the value
 * can only ever be a literal argv entry.
 */
describe("GitService command injection", () => {
	let repoDir: string;
	let markerPath: string;

	beforeEach(() => {
		repoDir = mkdtempSync(join(tmpdir(), "cyrus-inj-"));
		markerPath = join(repoDir, "PWNED");
		// A real repo so git reaches the ref-resolution stage rather than
		// failing earlier for an unrelated reason.
		execFileSync("git", ["init", "--quiet"], { cwd: repoDir });
		execFileSync("git", ["config", "user.email", "test@example.com"], {
			cwd: repoDir,
		});
		execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
		execFileSync("git", ["commit", "--allow-empty", "-m", "init", "--quiet"], {
			cwd: repoDir,
		});
	});

	afterEach(() => {
		rmSync(repoDir, { recursive: true, force: true });
	});

	it("does not execute a command-substitution payload in a base branch name", async () => {
		const gitService = new GitService();
		// Under a shell-string implementation this would create the marker file.
		const payload = `main$(touch ${markerPath})`;

		const result = await gitService.checkBaseBranchDrift(repoDir, payload);

		expect(existsSync(markerPath)).toBe(false);
		// No upstream ref resolves for a bogus branch, so drift reporting is skipped.
		expect(result).toBeNull();
	});

	it("does not execute a semicolon-chained payload in a base branch name", async () => {
		const gitService = new GitService();
		const payload = `main; touch ${markerPath}`;

		await gitService.checkBaseBranchDrift(repoDir, payload);

		expect(existsSync(markerPath)).toBe(false);
	});

	it("does not execute a backtick payload in a base branch name", async () => {
		const gitService = new GitService();
		const payload = `main\`touch ${markerPath}\``;

		await gitService.checkBaseBranchDrift(repoDir, payload);

		expect(existsSync(markerPath)).toBe(false);
	});
});
