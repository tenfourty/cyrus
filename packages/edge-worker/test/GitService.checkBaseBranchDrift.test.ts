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

// Touch unused imports so the lint config doesn't complain
void existsSync;
void mkdirSync;
void readdirSync;
void readFileSync;
void rmSync;
void statSync;

const mockExecSync = vi.mocked(execSync);

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

	function execMock(handler: (cmd: string) => string | Buffer) {
		mockExecSync.mockImplementation((cmd: any) => handler(String(cmd)) as any);
	}

	it("returns null when origin/<base> SHA did not change during the fetch", async () => {
		execMock((cmd) => {
			if (cmd.includes("rev-parse refs/remotes/origin/main")) {
				return "abc123\n";
			}
			if (cmd.includes("fetch origin")) {
				return "";
			}
			throw new Error(`unexpected git command: ${cmd}`);
		});

		const result = await gitService.checkBaseBranchDrift(
			"/worktree/path",
			"main",
		);

		expect(result).toBeNull();
	});

	it("returns drift info when origin/<base> moved during the fetch", async () => {
		const calls: string[] = [];
		let fetchCalled = false;
		mockExecSync.mockImplementation((cmd: any) => {
			const c = String(cmd);
			calls.push(c);
			if (c.includes("rev-parse") && c.includes("refs/remotes/origin/main")) {
				return (fetchCalled ? "def456\n" : "abc123\n") as any;
			}
			if (c.includes("fetch origin")) {
				fetchCalled = true;
				return "" as any;
			}
			if (
				c.includes("rev-list --count") &&
				c.includes("abc123") &&
				c.includes("def456")
			) {
				return "5\n" as any;
			}
			throw new Error(`unexpected git command: ${c}`);
		});

		const result = await gitService.checkBaseBranchDrift(
			"/worktree/path",
			"main",
		);

		expect(result).toEqual({ commitCount: 5, branchName: "main" });
	});

	it("returns null when there is no local tracking ref yet (first-ever fetch)", async () => {
		let fetchCalled = false;
		mockExecSync.mockImplementation((cmd: any) => {
			const c = String(cmd);
			if (c.includes("rev-parse") && c.includes("refs/remotes/origin/main")) {
				if (!fetchCalled) {
					throw new Error(
						"fatal: ambiguous argument 'refs/remotes/origin/main': unknown revision",
					);
				}
				return "def456\n" as any;
			}
			if (c.includes("fetch origin")) {
				fetchCalled = true;
				return "" as any;
			}
			throw new Error(`unexpected git command: ${c}`);
		});

		const result = await gitService.checkBaseBranchDrift(
			"/worktree/path",
			"main",
		);

		expect(result).toBeNull();
	});

	it("returns null and logs a warning when fetch fails", async () => {
		execMock((cmd) => {
			if (cmd.includes("rev-parse refs/remotes/origin/main")) {
				return "abc123\n";
			}
			if (cmd.includes("fetch origin")) {
				throw new Error("network down");
			}
			throw new Error(`unexpected git command: ${cmd}`);
		});

		const result = await gitService.checkBaseBranchDrift(
			"/worktree/path",
			"main",
		);

		expect(result).toBeNull();
		expect(mockLogger.warn).toHaveBeenCalled();
	});

	it("returns null when rev-list reports zero commits between the two SHAs", async () => {
		let fetchCalled = false;
		mockExecSync.mockImplementation((cmd: any) => {
			const c = String(cmd);
			if (c.includes("rev-parse") && c.includes("refs/remotes/origin/main")) {
				return (fetchCalled ? "def456\n" : "abc123\n") as any;
			}
			if (c.includes("fetch origin")) {
				fetchCalled = true;
				return "" as any;
			}
			if (c.includes("rev-list --count")) return "0\n" as any;
			throw new Error(`unexpected git command: ${c}`);
		});

		const result = await gitService.checkBaseBranchDrift(
			"/worktree/path",
			"main",
		);

		expect(result).toBeNull();
	});

	it("uses the provided base branch name (not hardcoded main) for fetch and rev-parse", async () => {
		const calls: string[] = [];
		mockExecSync.mockImplementation((cmd: any) => {
			const c = String(cmd);
			calls.push(c);
			if (c.includes("rev-parse refs/remotes/origin/develop")) {
				return "abc123\n" as any;
			}
			if (c.includes("fetch origin develop")) return "" as any;
			throw new Error(`unexpected git command: ${c}`);
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
	});
});
