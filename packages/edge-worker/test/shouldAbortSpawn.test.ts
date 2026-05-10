import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldAbortSpawn } from "../src/shouldAbortSpawn.js";

function makeManagerStub(opts: {
	hasSession?: boolean;
	stopRequested?: boolean;
}) {
	return {
		getSession: vi.fn(() =>
			(opts.hasSession ?? true) ? ({ id: "session-1" } as any) : undefined,
		),
		isStopRequested: vi.fn(() => opts.stopRequested ?? false),
	};
}

function makeSession(overrides: Record<string, unknown> = {}): any {
	return {
		id: "session-1",
		workspace: { path: "/tmp/will-be-overridden", isGitWorktree: true },
		...overrides,
	};
}

const silentLogger: any = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	withContext: function () {
		return this;
	},
};

describe("shouldAbortSpawn", () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "cyrus-abort-spawn-"));
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("returns null when session is tracked, no stop requested, and workspace exists", () => {
		const result = shouldAbortSpawn({
			session: makeSession({
				workspace: { path: tmpRoot, isGitWorktree: true },
			}),
			agentSessionManager: makeManagerStub({}),
			logger: silentLogger,
		});

		expect(result).toBeNull();
	});

	it("returns 'session-removed' when AgentSessionManager has dropped the session", () => {
		const result = shouldAbortSpawn({
			session: makeSession({
				workspace: { path: tmpRoot, isGitWorktree: true },
			}),
			agentSessionManager: makeManagerStub({ hasSession: false }),
			logger: silentLogger,
		});

		expect(result).toBe("session-removed");
	});

	it("returns 'stop-requested' when a stop has been requested for this session", () => {
		const manager = makeManagerStub({ stopRequested: true });
		const result = shouldAbortSpawn({
			session: makeSession({
				workspace: { path: tmpRoot, isGitWorktree: true },
			}),
			agentSessionManager: manager,
			logger: silentLogger,
		});

		expect(result).toBe("stop-requested");
		// Non-consuming check: the cleanup pipeline owns the stop flag's
		// lifecycle (it clears via removeSession), so the spawn-side abort
		// must not consume it.
		expect(manager.isStopRequested).toHaveBeenCalled();
	});

	it("returns 'worktree-missing' when the single-repo workspace path is gone", () => {
		const result = shouldAbortSpawn({
			session: makeSession({
				workspace: {
					path: join(tmpRoot, "vanished"),
					isGitWorktree: true,
				},
			}),
			agentSessionManager: makeManagerStub({}),
			logger: silentLogger,
		});

		expect(result).toBe("worktree-missing");
	});

	it("returns 'worktree-missing' when any sibling worktree path of a multi-repo session is gone", () => {
		const result = shouldAbortSpawn({
			session: makeSession({
				workspace: {
					path: tmpRoot,
					isGitWorktree: true,
					repoPaths: {
						"repo-a": tmpRoot,
						"repo-b": join(tmpRoot, "vanished-sibling"),
					},
				},
			}),
			agentSessionManager: makeManagerStub({}),
			logger: silentLogger,
		});

		expect(result).toBe("worktree-missing");
	});

	it("returns null for a multi-repo session whose every repoPath exists on disk", () => {
		const result = shouldAbortSpawn({
			session: makeSession({
				workspace: {
					path: tmpRoot,
					isGitWorktree: true,
					repoPaths: { "repo-a": tmpRoot, "repo-b": tmpRoot },
				},
			}),
			agentSessionManager: makeManagerStub({}),
			logger: silentLogger,
		});

		expect(result).toBeNull();
	});

	it("checks session-removed before stop-requested before worktree-missing (cheapest first)", () => {
		const manager = makeManagerStub({ hasSession: false, stopRequested: true });
		const result = shouldAbortSpawn({
			session: makeSession({
				workspace: { path: join(tmpRoot, "vanished"), isGitWorktree: true },
			}),
			agentSessionManager: manager,
			logger: silentLogger,
		});

		expect(result).toBe("session-removed");
		// short-circuit: subsequent checks don't run
		expect(manager.isStopRequested).not.toHaveBeenCalled();
	});

	it("returns 'draining' when isDraining() returns true", () => {
		const result = shouldAbortSpawn({
			session: makeSession({
				workspace: { path: tmpRoot, isGitWorktree: true },
			}),
			agentSessionManager: makeManagerStub({}),
			logger: silentLogger,
			isDraining: () => true,
		});

		expect(result).toBe("draining");
	});

	it("ignores draining accessor when undefined (back-compat)", () => {
		const result = shouldAbortSpawn({
			session: makeSession({
				workspace: { path: tmpRoot, isGitWorktree: true },
			}),
			agentSessionManager: makeManagerStub({}),
			logger: silentLogger,
		});

		expect(result).toBeNull();
	});
});
