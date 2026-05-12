import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager, type TelemetryResolver } from "../src/AgentSessionManager.js";
import type { IActivitySink } from "../src/sinks/IActivitySink.js";

const claudeResult = {
	type: "result",
	subtype: "success",
	is_error: false,
	duration_ms: 14200,
	duration_api_ms: 12100,
	num_turns: 1,
	total_cost_usd: 0.0421,
	stop_reason: "end_turn",
	session_id: "claude-s1",
	uuid: "u1",
	result: "the response body",
	usage: {
		input_tokens: 12340,
		output_tokens: 1205,
		cache_read_input_tokens: 8400,
		cache_creation_input_tokens: 320,
	},
	modelUsage: {},
	permission_denials: [],
} as unknown as SDKResultMessage;

interface Harness {
	manager: AgentSessionManager;
	sink: IActivitySink;
	spy: ReturnType<typeof vi.spyOn>;
	dir: string;
}

function makeHarness(opts: {
	resolver?: TelemetryResolver;
}): Harness {
	const dir = mkdtempSync(join(tmpdir(), "telemetry-mgr-"));
	const sink: IActivitySink = {
		id: "test-workspace",
		postActivity: vi.fn().mockResolvedValue({ activityId: "activity-123" }),
		createAgentSession: vi.fn().mockResolvedValue("session-123"),
	};
	const spy = vi.spyOn(sink, "postActivity");
	const manager = new AgentSessionManager(
		undefined,
		undefined,
		undefined,
		opts.resolver,
	);
	manager.createCyrusAgentSession(
		"s1",
		"issue-1",
		{
			id: "issue-1",
			identifier: "ABC-1",
			title: "test",
			description: "",
			branchName: "test-branch",
		},
		{ path: "/tmp", isGitWorktree: false },
		"linear",
		[{ repositoryId: "r1" }],
	);
	manager.setActivitySink("s1", sink);
	// Mark runner as Claude
	(manager as any).sessions.get("s1").agentRunner = {
		constructor: { name: "ClaudeRunner" },
	};
	return { manager, sink, spy, dir };
}

let dirs: string[] = [];
beforeEach(() => {
	dirs = [];
});
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("AgentSessionManager telemetry wiring", () => {
	it("when telemetry enabled: appends footer to result content, writes NDJSON, accumulates totals", async () => {
		const h = makeHarness({
			resolver: (repoId) => ({
				enabled: true,
				linearFooter: true,
				ndjsonDir: repoId === "r1" ? `${h?.dir ?? ""}` : undefined,
			}),
		});
		dirs.push(h.dir);
		// Re-wire resolver with concrete dir now that h.dir is captured
		(h.manager as any).telemetryResolver = (repoId: string) => ({
			enabled: true,
			linearFooter: true,
			ndjsonDir: h.dir,
		});

		await h.manager.completeSession("s1", claudeResult);

		// NDJSON written
		const file = readFileSync(join(h.dir, "s1.jsonl"), "utf8");
		expect(file.trim().split("\n")).toHaveLength(1);
		expect(JSON.parse(file).runner).toBe("claude");

		// Footer present in posted body
		const responseCall = h.spy.mock.calls.find(
			(c: any[]) => c[1]?.type === "response",
		);
		expect(responseCall).toBeDefined();
		const body = (responseCall as any)[1].body as string;
		expect(body).toContain("the response body");
		expect(body).toMatch(/— \$0\.0421 ·/);
	});

	it("when telemetry disabled (no resolver): no NDJSON, no footer", async () => {
		const h = makeHarness({});
		dirs.push(h.dir);
		await h.manager.completeSession("s1", claudeResult);
		expect(() => readFileSync(join(h.dir, "s1.jsonl"))).toThrow();
		const responseCall = h.spy.mock.calls.find(
			(c: any[]) => c[1]?.type === "response",
		);
		expect(responseCall).toBeDefined();
		const body = (responseCall as any)[1].body as string;
		expect(body).not.toMatch(/—/);
		expect(h.manager.getSession("s1")?.metadata?.telemetryTotals).toBeUndefined();
	});

	it("per-repo telemetry override (enabled: false) beats global enabled config", async () => {
		const h = makeHarness({
			resolver: () => ({ enabled: false, linearFooter: true }),
		});
		dirs.push(h.dir);
		await h.manager.completeSession("s1", claudeResult);
		expect(() => readFileSync(join(h.dir, "s1.jsonl"))).toThrow();
		const responseCall = h.spy.mock.calls.find(
			(c: any[]) => c[1]?.type === "response",
		);
		expect(((responseCall as any)[1].body as string)).not.toMatch(/—/);
	});

	it("partial per-repo override (ndjsonDir only, enabled absent) does not enable telemetry", async () => {
		const h = makeHarness({
			resolver: () => ({
				enabled: false,
				linearFooter: true,
				ndjsonDir: "/should-not-be-used",
			}),
		});
		dirs.push(h.dir);
		await h.manager.completeSession("s1", claudeResult);
		expect(() => readFileSync(join("/should-not-be-used", "s1.jsonl"))).toThrow();
	});

	it("posts NO trailing thought/action after the result activity (Linear UI state)", async () => {
		// Critical invariant: Linear's session state is inferred from the LAST
		// activity's content.type. A `response` flips state to `complete`;
		// any subsequent `thought`/`action`/`elicitation` demotes back to
		// `active` (pinning the UI as "still working"). The telemetry feature
		// must NOT post anything after the result entry.
		const h = makeHarness({
			resolver: () => ({
				enabled: true,
				linearFooter: true,
				ndjsonDir: undefined,
			}),
		});
		dirs.push(h.dir);
		await h.manager.completeSession("s1", claudeResult);

		const types = h.spy.mock.calls.map((c: any[]) => c[1]?.type);
		const lastResponseIdx = types.lastIndexOf("response");
		const errorIdx = types.lastIndexOf("error");
		const finalActivityIdx = Math.max(lastResponseIdx, errorIdx);
		expect(finalActivityIdx).toBeGreaterThan(-1);
		// No thought/action/elicitation posted after the final response
		const trailingActivityTypes = types.slice(finalActivityIdx + 1);
		expect(trailingActivityTypes).toEqual([]);
	});
});
