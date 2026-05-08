import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(),
}));

vi.mock("../src/sandbox-requirements", () => ({
	checkLinuxSandboxRequirements: vi.fn(() => ({
		supported: true,
		platform: "linux",
		failures: [],
	})),
	logSandboxRequirementFailures: vi.fn(),
	resetSandboxRequirementsCacheForTesting: vi.fn(),
}));

const envFileContents = new Map<string, string>();

vi.mock("fs", () => ({
	mkdirSync: vi.fn(),
	existsSync: vi.fn((path: string) => {
		if (typeof path === "string" && path.endsWith(".env")) {
			return envFileContents.has(path);
		}
		return false;
	}),
	readFileSync: vi.fn((path: string) => {
		if (typeof path === "string" && envFileContents.has(path)) {
			return envFileContents.get(path);
		}
		return "";
	}),
	createWriteStream: vi.fn(() => ({
		write: vi.fn(),
		end: vi.fn(),
		on: vi.fn(),
	})),
	writeFileSync: vi.fn(),
}));

vi.mock("os", () => ({
	homedir: vi.fn(() => "/mock/home"),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeRunner } from "../src/ClaudeRunner";
import { buildBaseSessionEnv } from "../src/session-env";
import type { ClaudeRunnerConfig } from "../src/types";

describe("CLAUDE_CODE_STREAM_CLOSE_TIMEOUT default (workaround for upstream issue #114)", () => {
	let mockQuery: any;
	const originalEnvValue = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;

	const makeConfig = (workingDirectory: string): ClaudeRunnerConfig => ({
		workingDirectory,
		cyrusHome: "/tmp/test-cyrus-home",
	});

	function mockSuccessfulQuery() {
		mockQuery.mockImplementation(async function* () {
			yield {
				type: "assistant",
				message: { content: [{ type: "text", text: "Done" }] },
				parent_tool_use_id: null,
				session_id: "test-session",
			} as any;
		});
	}

	function getQueryEnv(): Record<string, string> {
		const call = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
		return call[0].options.env;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		envFileContents.clear();
		mockQuery = vi.mocked(query);
		delete process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
	});

	afterEach(() => {
		envFileContents.clear();
		if (originalEnvValue === undefined) {
			delete process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
		} else {
			process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = originalEnvValue;
		}
	});

	it("buildBaseSessionEnv sets CLAUDE_CODE_STREAM_CLOSE_TIMEOUT to 600000 (10 minutes) by default", () => {
		const env = buildBaseSessionEnv();
		expect(env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT).toBe("600000");
	});

	it("ClaudeRunner injects CLAUDE_CODE_STREAM_CLOSE_TIMEOUT=600000 into the SDK subprocess env", async () => {
		mockSuccessfulQuery();
		const runner = new ClaudeRunner(makeConfig("/repo-a"));
		await runner.start("test");

		const env = getQueryEnv();
		expect(env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT).toBe("600000");
	});

	it("repository .env value overrides the default timeout", async () => {
		envFileContents.set(
			"/repo-a/.env",
			"CLAUDE_CODE_STREAM_CLOSE_TIMEOUT=900000",
		);

		mockSuccessfulQuery();
		const runner = new ClaudeRunner(makeConfig("/repo-a"));
		await runner.start("test");

		const env = getQueryEnv();
		expect(env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT).toBe("900000");
	});

	it("additionalEnv on the runner config overrides the default timeout", async () => {
		mockSuccessfulQuery();
		const runner = new ClaudeRunner({
			...makeConfig("/repo-a"),
			additionalEnv: { CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: "1200000" },
		});
		await runner.start("test");

		const env = getQueryEnv();
		expect(env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT).toBe("1200000");
	});
});
