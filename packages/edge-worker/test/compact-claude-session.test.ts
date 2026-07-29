import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Claude Agent SDK before the executor imports it
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(),
}));
// Mock the runner's session-env (avoid pulling in real auth env) and the
// home-directory deny builder (its real output depends on the machine's
// actual home directory contents).
vi.mock("cyrus-claude-runner", async () => {
	return {
		buildBaseSessionEnv: () => ({ FAKE_BASE: "1" }),
		buildHomeDirectoryDisallowedTools: (
			cwd: string,
			allowed: string[] = [],
		) => [
			`Read(//home/fake/secrets/**)|cwd=${cwd}|allowed=${allowed.join(",")}`,
		],
	};
});

import { query } from "@anthropic-ai/claude-agent-sdk";
import { compactClaudeSession } from "../src/compact-claude-session.js";

const silentLogger: any = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
	withContext: function () {
		return this;
	},
};

/** Always-required confinement args, so each test states its own posture. */
const noConfinement = {
	sandbox: undefined,
	disallowedTools: undefined,
	allowedDirectories: undefined,
};

const COMPACT_BOUNDARY = {
	type: "system",
	subtype: "compact_boundary",
	compact_metadata: {
		trigger: "manual",
		pre_tokens: 960_000,
		post_tokens: 7_000,
	},
};

const SUCCESS_RESULT = {
	type: "result",
	subtype: "success",
	is_error: false,
};

function makeIterable(...messages: Record<string, unknown>[]) {
	return (async function* () {
		for (const message of messages) {
			yield message;
		}
	})();
}

describe("compactClaudeSession", () => {
	beforeEach(() => {
		(query as any).mockReset();
	});

	it("invokes the SDK with `/compact` and the existing claude session id", async () => {
		(query as any).mockImplementation(() =>
			makeIterable(COMPACT_BOUNDARY, SUCCESS_RESULT),
		);

		const result = await compactClaudeSession({
			claudeSessionId: "claude-abc",
			workingDirectory: "/tmp/repo",
			...noConfinement,
			logger: silentLogger,
		});

		expect(result.ok).toBe(true);
		expect(result.preTokens).toBe(960_000);
		expect(result.postTokens).toBe(7_000);

		const call = (query as any).mock.calls[0][0];
		expect(call.prompt).toBe("/compact");
		expect(call.options.resume).toBe("claude-abc");
		expect(call.options.cwd).toBe("/tmp/repo");
	});

	it("threads additionalEnv on top of the base session env", async () => {
		(query as any).mockImplementation(() =>
			makeIterable(COMPACT_BOUNDARY, SUCCESS_RESULT),
		);

		await compactClaudeSession({
			claudeSessionId: "claude-1",
			workingDirectory: "/tmp/repo",
			...noConfinement,
			additionalEnv: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "75" },
			logger: silentLogger,
		});

		const call = (query as any).mock.calls[0][0];
		expect(call.options.env.FAKE_BASE).toBe("1");
		expect(call.options.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("75");
	});

	// ---------------------------------------------------------------------
	// Confinement. `/compact` spawns a REAL Claude Code session against the
	// issue worktree, whose contents an issue author can influence via the
	// branch it was created from. If these options regress, that session runs
	// outside the OS sandbox and/or executes SessionStart/PreCompact hooks
	// declared in the worktree's own .claude/settings*.json.
	// ---------------------------------------------------------------------
	describe("confinement of the spawned session", () => {
		const sandbox = {
			enabled: true,
			allowUnsandboxedCommands: false,
			filesystem: {
				allowRead: [".", "/ws/attachments"],
				denyRead: ["~/"],
				allowWrite: ["/tmp/repo"],
			},
		} as any;

		async function runWithConfinement() {
			(query as any).mockImplementation(() =>
				makeIterable(COMPACT_BOUNDARY, SUCCESS_RESULT),
			);
			await compactClaudeSession({
				claudeSessionId: "claude-1",
				workingDirectory: "/tmp/repo",
				sandbox,
				disallowedTools: ["Bash(rm:*)", "WebFetch"],
				allowedDirectories: ["/ws/attachments"],
				logger: silentLogger,
			});
			return (query as any).mock.calls[0][0].options;
		}

		it("passes the caller's sandbox settings through to the SDK", async () => {
			const options = await runWithConfinement();
			expect(options.sandbox).toEqual(sandbox);
		});

		it("sets strictMcpConfig so ambient MCP servers are never inherited", async () => {
			const options = await runWithConfinement();
			expect(options.strictMcpConfig).toBe(true);
		});

		it("loads only the `user` setting source — never `project` or `local`", async () => {
			const options = await runWithConfinement();
			expect(options.settingSources).toEqual(["user"]);
			// The worktree's own .claude/settings.json and
			// .claude/settings.local.json carry hooks that execute shell
			// commands; the worktree is repo content, so loading them here
			// would be repo-content-driven command execution.
			expect(options.settingSources).not.toContain("project");
			expect(options.settingSources).not.toContain("local");
		});

		it("merges the caller's disallowedTools with the home-directory denials, deduplicated", async () => {
			const options = await runWithConfinement();
			expect(options.disallowedTools).toEqual([
				"Bash(rm:*)",
				"WebFetch",
				"Read(//home/fake/secrets/**)|cwd=/tmp/repo|allowed=/ws/attachments",
			]);
		});

		it("omits the sandbox key entirely when the real turn is unsandboxed", async () => {
			(query as any).mockImplementation(() =>
				makeIterable(COMPACT_BOUNDARY, SUCCESS_RESULT),
			);
			await compactClaudeSession({
				claudeSessionId: "claude-1",
				workingDirectory: "/tmp/repo",
				...noConfinement,
				logger: silentLogger,
			});
			const options = (query as any).mock.calls[0][0].options;
			expect("sandbox" in options).toBe(false);
			// Home-directory denials still apply with no sandbox — the
			// tool-permission layer is the only protection in that case.
			expect(options.disallowedTools).toEqual([
				"Read(//home/fake/secrets/**)|cwd=/tmp/repo|allowed=",
			]);
		});
	});

	// ---------------------------------------------------------------------
	// Success is defined by an observed compact boundary, not by the result
	// message. `compact_metadata` lives on SDKCompactBoundaryMessage
	// (type: "system", subtype: "compact_boundary"), never on the result.
	// ---------------------------------------------------------------------
	describe("compact boundary detection", () => {
		it("reads pre/post tokens from the compact_boundary message, not the result message", async () => {
			(query as any).mockImplementation(() =>
				makeIterable(
					{
						type: "system",
						subtype: "compact_boundary",
						compact_metadata: {
							trigger: "manual",
							pre_tokens: 123_456,
							post_tokens: 7_890,
						},
					},
					// A result message carrying a bogus compact_metadata must be
					// ignored — the SDK never puts one there.
					{
						type: "result",
						subtype: "success",
						is_error: false,
						compact_metadata: { pre_tokens: 1, post_tokens: 2 },
					},
				),
			);

			const result = await compactClaudeSession({
				claudeSessionId: "claude-1",
				workingDirectory: "/tmp/repo",
				...noConfinement,
				logger: silentLogger,
			});

			expect(result.ok).toBe(true);
			expect(result.preTokens).toBe(123_456);
			expect(result.postTokens).toBe(7_890);
		});

		it("reports ok:false when /compact completes without compacting anything", async () => {
			// A no-op `/compact` (nothing to summarize) still emits a clean
			// success result. Reporting ok:true there would tell the caller an
			// over-budget transcript had been shrunk when it had not.
			(query as any).mockImplementation(() => makeIterable(SUCCESS_RESULT));

			const result = await compactClaudeSession({
				claudeSessionId: "claude-1",
				workingDirectory: "/tmp/repo",
				...noConfinement,
				logger: silentLogger,
			});

			expect(result.ok).toBe(false);
			expect(result.error).toContain("compact boundary");
		});

		it("still reports ok:true when the boundary omits post_tokens", async () => {
			// post_tokens is optional in SDKCompactBoundaryMessage.
			(query as any).mockImplementation(() =>
				makeIterable(
					{
						type: "system",
						subtype: "compact_boundary",
						compact_metadata: { trigger: "auto", pre_tokens: 500_000 },
					},
					SUCCESS_RESULT,
				),
			);

			const result = await compactClaudeSession({
				claudeSessionId: "claude-1",
				workingDirectory: "/tmp/repo",
				...noConfinement,
				logger: silentLogger,
			});

			expect(result.ok).toBe(true);
			expect(result.preTokens).toBe(500_000);
			expect(result.postTokens).toBeUndefined();
		});
	});

	it("returns ok:false with the SDK error text when the compact result is is_error: true", async () => {
		(query as any).mockImplementation(() =>
			makeIterable({
				type: "result",
				subtype: "success",
				is_error: true,
				result: "Prompt is too long",
			}),
		);

		const result = await compactClaudeSession({
			claudeSessionId: "claude-wedged",
			workingDirectory: "/tmp/repo",
			...noConfinement,
			logger: silentLogger,
		});

		expect(result.ok).toBe(false);
		expect(result.error).toBe("Prompt is too long");
	});

	it("returns ok:false when the SDK throws (transport error, etc.)", async () => {
		(query as any).mockImplementation(() => {
			throw new Error("ECONNRESET");
		});

		const result = await compactClaudeSession({
			claudeSessionId: "claude-1",
			workingDirectory: "/tmp/repo",
			...noConfinement,
			logger: silentLogger,
		});

		expect(result.ok).toBe(false);
		expect(result.error).toContain("ECONNRESET");
	});

	it("returns ok:false when the stream closes without a result message", async () => {
		(query as any).mockImplementation(() =>
			makeIterable({ type: "assistant", message: { content: [] } }),
		);

		const result = await compactClaudeSession({
			claudeSessionId: "claude-1",
			workingDirectory: "/tmp/repo",
			...noConfinement,
			logger: silentLogger,
		});

		expect(result.ok).toBe(false);
		expect(result.error).toContain("stream closed");
	});
});
