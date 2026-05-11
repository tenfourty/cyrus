/**
 * Tests for PersistenceManager concurrent-save coalescing.
 *
 * Two callers invoking saveEdgeWorkerState back-to-back with different
 * snapshots used to race: each save serialized its own snapshot then wrote
 * the file, and whichever write completed last "won" — non-deterministically.
 * On long-running edge workers this meant a session that flipped status to
 * Complete in memory could persist a pre-flip Active snapshot if its save
 * raced with an earlier save that started before the flip.
 *
 * Coalescing makes the latest-initiated save win deterministically: a save
 * arriving while another is in flight replaces any already-queued snapshot,
 * and the chained save runs exactly once with the latest state.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PersistenceManager } from "../src/PersistenceManager.js";

function makeState(marker: string) {
	return {
		ndjsonClientStates: {},
		agentSessions: {
			repoA: {
				[marker]: {
					id: marker,
					issueId: "ISSUE-1",
					type: "linear",
					status: "active",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					workspace: { path: "/tmp/x", isGitWorktree: false },
					issue: {
						id: "ISSUE-1",
						identifier: "TEST-1",
						title: "t",
						description: "",
						branchName: "b",
					},
				},
			},
		},
		agentSessionEntries: {},
	};
}

describe("PersistenceManager concurrent save coalescing", () => {
	let dir: string;
	let manager: PersistenceManager;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "cyrus-persist-coalesce-"));
		manager = new PersistenceManager(dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function readSavedMarker(): Promise<string | null> {
		const raw = await readFile(
			join(dir, "edge-worker-state.json"),
			"utf8",
		);
		const data = JSON.parse(raw) as {
			state: { agentSessions: Record<string, Record<string, unknown>> };
		};
		const repo = data.state.agentSessions.repoA ?? {};
		const keys = Object.keys(repo);
		return keys[0] ?? null;
	}

	it("when two saves are kicked off back-to-back, the on-disk content matches the LATEST snapshot", async () => {
		// Without coalescing the two saves race on writeFile/rename and which
		// snapshot wins is non-deterministic. Coalescing guarantees the latest
		// initiated save wins.
		const stateA = makeState("snapshot-a");
		const stateB = makeState("snapshot-b");

		const saveA = manager.saveEdgeWorkerState(
			stateA as unknown as Parameters<
				typeof manager.saveEdgeWorkerState
			>[0],
		);
		const saveB = manager.saveEdgeWorkerState(
			stateB as unknown as Parameters<
				typeof manager.saveEdgeWorkerState
			>[0],
		);

		await Promise.all([saveA, saveB]);

		expect(await readSavedMarker()).toBe("snapshot-b");
	});

	it("coalesces a burst of saves to the final snapshot", async () => {
		const promises = Array.from({ length: 10 }, (_, i) =>
			manager.saveEdgeWorkerState(
				makeState(`snapshot-${i}`) as unknown as Parameters<
					typeof manager.saveEdgeWorkerState
				>[0],
			),
		);

		await Promise.all(promises);

		expect(await readSavedMarker()).toBe("snapshot-9");
	});
});
