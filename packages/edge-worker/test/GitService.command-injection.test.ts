import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitService } from "../src/GitService.js";
import { isPlausibleGitRef } from "../src/RepositoryRouter.js";

/**
 * Regression tests for command injection via git invocations.
 *
 * A base-branch override parsed out of a `[repo=name#branch]` issue-description
 * tag is untrusted text. It used to be interpolated into a shell string
 * (`execSync(`git fetch origin "${baseBranch}"`)`), so a payload containing
 * `$(...)` executed on the host: double quotes do not prevent command
 * substitution. Git is now invoked with an argument vector, so the value can
 * only ever be a literal argv entry.
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
		// Under the old shell-string implementation this created the marker file.
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

describe("isPlausibleGitRef", () => {
	it("accepts ordinary branch names", () => {
		for (const ref of [
			"main",
			"develop",
			"feature/ENG-123-add-thing",
			"release/1.2.3",
			"user_name/fix.thing",
		]) {
			expect(isPlausibleGitRef(ref), ref).toBe(true);
		}
	});

	it("rejects every shell-metacharacter payload", () => {
		for (const ref of [
			"main$(id)",
			"main;id",
			'main";id;"',
			"main`id`",
			"main|id",
			"main&&id",
			"main\nid",
			"main id",
			"main>out",
			"main<in",
			"main$IFS",
			"main'id'",
		]) {
			expect(isPlausibleGitRef(ref), ref).toBe(false);
		}
	});

	it("rejects names git itself forbids", () => {
		for (const ref of [
			"",
			"..",
			"main..dev",
			"main.lock",
			".main",
			"main.",
			"-main",
			"main-",
			"/main",
			"main/",
		]) {
			expect(isPlausibleGitRef(ref), ref).toBe(false);
		}
	});
});
