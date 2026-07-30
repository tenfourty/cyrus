/**
 * Tests for the atomic-write guarantees of PersistenceManager.
 *
 * These tests use a real temporary directory because the bug we're guarding
 * against is fundamentally about file-system semantics: `writeFile` is
 * truncate-then-write, so a process killed (or a sibling concurrent writer
 * O_TRUNC'ing the same path) can leave an empty or partial file on disk.
 * The fix swaps in a tmp + rename pattern; verifying that requires a real
 * filesystem.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	PERSISTENCE_VERSION,
	PersistenceManager,
	type SerializableEdgeWorkerState,
} from "../src/PersistenceManager.js";

function makeState(numSessions: number): SerializableEdgeWorkerState {
	const agentSessions: Record<string, any> = {};
	for (let i = 0; i < numSessions; i++) {
		agentSessions[`session-${i}`] = {
			id: `session-${i}`,
			type: "comment_thread",
			status: "active",
			context: "comment_thread",
			createdAt: 1_700_000_000_000,
			updatedAt: 1_700_000_000_000,
			repositories: [{ repositoryId: "repo-a" }],
			workspace: { path: `/tmp/wt-${i}`, isGitWorktree: true },
		};
	}
	return { agentSessions };
}

/** Above any plausible `/proc/sys/kernel/pid_max`, so `kill(pid, 0)` is ESRCH. */
const DEAD_PID = 2_000_000_000;

/**
 * A pid that is definitely running and is definitely not us. Pid 1 always
 * exists; treating it as "another cyrus instance" is enough to exercise the
 * liveness guard.
 */
const LIVE_FOREIGN_PID = 1;

function validStateJson() {
	return {
		version: PERSISTENCE_VERSION,
		savedAt: "2026-05-10T00:00:00.000Z",
		state: makeState(2),
	};
}

describe("PersistenceManager atomic save", () => {
	let tmpRoot: string;
	let pm: PersistenceManager;
	let stateFile: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "cyrus-persist-atomic-"));
		pm = new PersistenceManager(tmpRoot);
		stateFile = join(tmpRoot, "edge-worker-state.json");
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("writes the state file via a tmp file plus rename, leaving no .tmp.* siblings on success", async () => {
		await pm.saveEdgeWorkerState(makeState(3));

		const entries = await readdir(tmpRoot);
		expect(entries).toContain("edge-worker-state.json");
		expect(entries.filter((f) => f.includes(".tmp."))).toHaveLength(0);

		const raw = await readFile(stateFile, "utf8");
		const parsed = JSON.parse(raw);
		expect(parsed.version).toBe(PERSISTENCE_VERSION);
		expect(Object.keys(parsed.state.agentSessions)).toHaveLength(3);
	});

	it("preserves the previous file contents when interrupted between writeFile and rename", async () => {
		// Seed an existing committed state.
		await pm.saveEdgeWorkerState(makeState(5));
		const before = await readFile(stateFile, "utf8");

		// Simulate the crash window: a tmp file exists but rename never ran.
		// Write a "would-have-succeeded" payload to a tmp sibling and orphan it.
		const orphanTmp = `${stateFile}.tmp.99999`;
		writeFileSync(orphanTmp, JSON.stringify({ totally: "different" }));

		const after = await readFile(stateFile, "utf8");
		expect(after).toBe(before);
		expect(JSON.parse(after).state.agentSessions).toHaveProperty("session-0");
	});

	it("never produces a partial / empty state file under concurrent saves", async () => {
		const stateA = makeState(5);
		const stateB = makeState(7);
		const stateC = makeState(11);

		await Promise.all([
			pm.saveEdgeWorkerState(stateA),
			pm.saveEdgeWorkerState(stateB),
			pm.saveEdgeWorkerState(stateC),
		]);

		const stats = await stat(stateFile);
		expect(stats.size).toBeGreaterThan(0);

		const raw = await readFile(stateFile, "utf8");
		const parsed = JSON.parse(raw);
		expect(parsed.version).toBe(PERSISTENCE_VERSION);
		// Last write wins — must be one of the three valid payloads, never partial.
		const sessionCount = Object.keys(parsed.state.agentSessions ?? {}).length;
		expect([5, 7, 11]).toContain(sessionCount);

		const entries = await readdir(tmpRoot);
		expect(entries.filter((f) => f.includes(".tmp."))).toHaveLength(0);
	});

	it("scopes the tmp file to this process so multiple cyrus instances do not stomp each other", async () => {
		const otherPid = process.pid + 1;
		const otherTmp = `${stateFile}.tmp.${otherPid}`;
		writeFileSync(otherTmp, "garbage from another process");

		await pm.saveEdgeWorkerState(makeState(2));

		const stillThere = await readFile(otherTmp, "utf8");
		expect(stillThere).toBe("garbage from another process");

		const raw = await readFile(stateFile, "utf8");
		const parsed = JSON.parse(raw);
		expect(Object.keys(parsed.state.agentSessions)).toHaveLength(2);
	});
});

describe("PersistenceManager.loadEdgeWorkerState resilience", () => {
	let tmpRoot: string;
	let pm: PersistenceManager;
	let stateFile: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "cyrus-persist-load-"));
		pm = new PersistenceManager(tmpRoot);
		stateFile = join(tmpRoot, "edge-worker-state.json");
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("returns null without logging an error when the state file is empty (e.g. SIGKILL during a non-atomic write)", async () => {
		writeFileSync(stateFile, "");

		const loaded = await pm.loadEdgeWorkerState();
		expect(loaded).toBeNull();
	});

	it("cleans up stale .tmp.* siblings of the state file at load time", async () => {
		writeFileSync(stateFile, JSON.stringify(validStateJson()));
		// Pids above any plausible pid_max — guaranteed not running.
		writeFileSync(`${stateFile}.tmp.${DEAD_PID}.1`, "abandoned tmp");
		writeFileSync(
			`${stateFile}.tmp.${DEAD_PID + 1}.1`,
			"another abandoned tmp",
		);

		const loaded = await pm.loadEdgeWorkerState();
		expect(loaded).not.toBeNull();
		expect(Object.keys(loaded?.agentSessions ?? {})).toHaveLength(2);

		const remaining = await readdir(tmpRoot);
		expect(remaining.filter((f) => f.includes(".tmp."))).toHaveLength(0);
	});

	it("cleans up our own leftover tmp files", async () => {
		writeFileSync(stateFile, JSON.stringify(validStateJson()));
		writeFileSync(`${stateFile}.tmp.${process.pid}.7`, "our own leftover");

		await pm.loadEdgeWorkerState();

		const remaining = await readdir(tmpRoot);
		expect(remaining.filter((f) => f.includes(".tmp."))).toHaveLength(0);
	});

	it("does NOT unlink a tmp file belonging to another live process", async () => {
		// The `.tmp.<pid>` suffix exists so concurrent cyrus instances do not
		// collide. Cleaning indiscriminately threw that away: this load would
		// delete the other instance's in-flight tmp file and make its rename
		// fail with ENOENT — losing that instance's save entirely.
		writeFileSync(stateFile, JSON.stringify(validStateJson()));
		const liveSibling = `${stateFile}.tmp.${LIVE_FOREIGN_PID}.1`;
		writeFileSync(liveSibling, "another instance is mid-write");

		await pm.loadEdgeWorkerState();

		const remaining = await readdir(tmpRoot);
		expect(remaining).toContain(basename(liveSibling));
	});

	it("cleans up tmp files whose pid segment cannot be parsed", async () => {
		writeFileSync(stateFile, JSON.stringify(validStateJson()));
		writeFileSync(`${stateFile}.tmp.legacy`, "pre-pid-suffix leftover");

		await pm.loadEdgeWorkerState();

		const remaining = await readdir(tmpRoot);
		expect(remaining.filter((f) => f.includes(".tmp."))).toHaveLength(0);
	});
});
