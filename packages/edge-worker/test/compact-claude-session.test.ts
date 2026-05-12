import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Claude Agent SDK before the executor imports it
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(),
}));
// Mock the runner's session-env (avoid pulling in real auth env)
vi.mock("cyrus-claude-runner", async () => {
	return {
		buildBaseSessionEnv: () => ({ FAKE_BASE: "1" }),
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

function makeResultIterable(message: Record<string, unknown>) {
	return (async function* () {
		yield message;
	})();
}

describe("compactClaudeSession", () => {
	beforeEach(() => {
		(query as any).mockReset();
	});

	it("invokes the SDK with `/compact` and the existing claude session id", async () => {
		(query as any).mockImplementation(() =>
			makeResultIterable({
				type: "result",
				subtype: "success",
				is_error: false,
				compact_metadata: { pre_tokens: 960_000, post_tokens: 7_000 },
			}),
		);

		const result = await compactClaudeSession({
			claudeSessionId: "claude-abc",
			workingDirectory: "/tmp/repo",
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
			makeResultIterable({
				type: "result",
				subtype: "success",
				is_error: false,
			}),
		);

		await compactClaudeSession({
			claudeSessionId: "claude-1",
			workingDirectory: "/tmp/repo",
			additionalEnv: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "75" },
			logger: silentLogger,
		});

		const call = (query as any).mock.calls[0][0];
		expect(call.options.env.FAKE_BASE).toBe("1");
		expect(call.options.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("75");
	});

	it("returns ok:false with the SDK error text when the compact result is is_error: true", async () => {
		(query as any).mockImplementation(() =>
			makeResultIterable({
				type: "result",
				subtype: "success",
				is_error: true,
				result: "Prompt is too long",
			}),
		);

		const result = await compactClaudeSession({
			claudeSessionId: "claude-wedged",
			workingDirectory: "/tmp/repo",
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
			logger: silentLogger,
		});

		expect(result.ok).toBe(false);
		expect(result.error).toContain("ECONNRESET");
	});

	it("returns ok:false when the stream closes without a result message", async () => {
		(query as any).mockImplementation(() =>
			(async function* () {
				yield { type: "assistant", message: { content: [] } } as any;
				// no result message, stream just ends
			})(),
		);

		const result = await compactClaudeSession({
			claudeSessionId: "claude-1",
			workingDirectory: "/tmp/repo",
			logger: silentLogger,
		});

		expect(result.ok).toBe(false);
		expect(result.error).toContain("stream closed");
	});
});
