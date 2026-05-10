import { homedir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withAutoMemoryAllowedDirectory } from "../src/RunnerConfigBuilder.js";

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: vi.fn() };
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("withAutoMemoryAllowedDirectory", () => {
	it("appends the per-repo auto-memory directory to allowedDirectories", () => {
		vi.mocked(homedir).mockReturnValue("/root");

		const result = withAutoMemoryAllowedDirectory(
			["/root/.cyrus/worktrees/ENG-1/repoA", "/root/.cyrus/repos/repoA"],
			"/root/.cyrus/repos/repoA",
		);

		expect(result).toEqual([
			"/root/.cyrus/worktrees/ENG-1/repoA",
			"/root/.cyrus/repos/repoA",
			"/root/.claude/projects/-root--cyrus-repos-repoA/memory",
		]);
	});

	it("does not duplicate the auto-memory directory if a caller already added it", () => {
		vi.mocked(homedir).mockReturnValue("/root");
		const memoryDir = "/root/.claude/projects/-root--cyrus-repos-repoA/memory";

		const result = withAutoMemoryAllowedDirectory(
			["/root/.cyrus/repos/repoA", memoryDir],
			"/root/.cyrus/repos/repoA",
		);

		expect(result.filter((p) => p === memoryDir)).toHaveLength(1);
	});

	it("uses the bare repo path (not the worktree) to derive the encoded project name", () => {
		vi.mocked(homedir).mockReturnValue("/Users/alice");

		const result = withAutoMemoryAllowedDirectory(
			["/Users/alice/.cyrus/worktrees/ENG-1/repo"],
			"/Users/alice/.cyrus/repos/myrepo",
		);

		expect(result).toContain(
			"/Users/alice/.claude/projects/-Users-alice--cyrus-repos-myrepo/memory",
		);
		// The encoded name must NOT come from the worktree path
		expect(result).not.toContain(
			"/Users/alice/.claude/projects/-Users-alice--cyrus-worktrees-ENG-1-repo/memory",
		);
	});
});
