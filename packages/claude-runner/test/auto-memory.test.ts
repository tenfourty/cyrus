import { homedir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	encodeClaudeProjectDirName,
	getClaudeProjectAutoMemoryDir,
} from "../src/auto-memory.js";

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: vi.fn() };
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("encodeClaudeProjectDirName", () => {
	it("encodes a typical repo path the same way Claude Code does (slashes and dots → dashes)", () => {
		expect(encodeClaudeProjectDirName("/root/.cyrus/repos/cove")).toBe(
			"-root--cyrus-repos-cove",
		);
	});

	it("encodes a macOS-style absolute path", () => {
		expect(encodeClaudeProjectDirName("/Users/jeremy.brown/dev/cyrus")).toBe(
			"-Users-jeremy-brown-dev-cyrus",
		);
	});

	it("encodes a path without dots", () => {
		expect(encodeClaudeProjectDirName("/srv/repos/foo")).toBe("-srv-repos-foo");
	});

	it("encodes a deeply-nested path with multiple dots", () => {
		expect(
			encodeClaudeProjectDirName("/home/agent/.cyrus/repos/.config/foo"),
		).toBe("-home-agent--cyrus-repos--config-foo");
	});
});

describe("getClaudeProjectAutoMemoryDir", () => {
	it("returns ~/.claude/projects/<encoded>/memory for the given repo path", () => {
		vi.mocked(homedir).mockReturnValue("/root");
		expect(getClaudeProjectAutoMemoryDir("/root/.cyrus/repos/cove")).toBe(
			"/root/.claude/projects/-root--cyrus-repos-cove/memory",
		);
	});

	it("uses the calling user's home (not a hardcoded /root)", () => {
		vi.mocked(homedir).mockReturnValue("/Users/alice");
		expect(getClaudeProjectAutoMemoryDir("/Users/alice/dev/cyrus")).toBe(
			"/Users/alice/.claude/projects/-Users-alice-dev-cyrus/memory",
		);
	});
});
