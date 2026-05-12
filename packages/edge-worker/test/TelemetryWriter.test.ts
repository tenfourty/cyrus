import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerTelemetryRecord } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TelemetryWriter } from "../src/TelemetryWriter.js";

const sample: RunnerTelemetryRecord = {
	schemaVersion: 1,
	runner: "codex",
	sessionId: "s-test",
	entryId: "e1",
	repoId: "r1",
	model: "gpt-5-codex",
	timestamp: "2026-05-12T10:00:00.000Z",
	durationMs: 1000,
	isError: false,
	usage: { input_tokens: 10, output_tokens: 5 },
	toolCalls: { total: 0, byName: {} },
};

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "telemetry-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("TelemetryWriter", () => {
	it("appends a JSON line per turn to <sessionId>.jsonl", async () => {
		const w = new TelemetryWriter(dir);
		await w.appendTurn(sample);
		await w.appendTurn({ ...sample, entryId: "e2" });
		const file = readFileSync(join(dir, "s-test.jsonl"), "utf8");
		const lines = file.trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]).entryId).toBe("e1");
		expect(JSON.parse(lines[1]).entryId).toBe("e2");
	});

	it("creates the directory if it does not exist", async () => {
		const nested = join(dir, "nested", "deep");
		const w = new TelemetryWriter(nested);
		await w.appendTurn(sample);
		expect(readFileSync(join(nested, "s-test.jsonl"), "utf8")).toContain(
			'"s-test"',
		);
	});

	it("never throws on disk errors (swallows + logs)", async () => {
		const logs: string[] = [];
		const w = new TelemetryWriter("/dev/null/nope-cannot-write-here", {
			onError: (msg) => logs.push(msg),
		});
		await expect(w.appendTurn(sample)).resolves.toBeUndefined();
		expect(logs[0]).toContain("telemetry write failed");
	});
});
