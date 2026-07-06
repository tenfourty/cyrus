import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Claude SDK
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(),
}));

// Mock file system operations
vi.mock("fs", () => ({
	mkdirSync: vi.fn(),
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn(() => ""),
	createWriteStream: vi.fn(() => ({
		write: vi.fn(),
		end: vi.fn(),
		on: vi.fn(),
	})),
}));

// Mock os module
vi.mock("os", () => ({
	homedir: vi.fn(() => "/mock/home"),
}));

import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "cyrus-core";
import { ClaudeRunner } from "../src/ClaudeRunner";
import type { ClaudeRunnerConfig } from "../src/types";

/**
 * Covers the `AskUserQuestion` multi-question guard THROUGH the real
 * `canUseTool` callback produced by `ClaudeRunner.createCanUseToolCallback`
 * (rather than only unit-testing the extracted `validateAskUserQuestionInput`
 * helper in isolation) — see `feedback_test_the_seam`: a helper-only test
 * would repeat the exact coverage gap this task closes, since the guard
 * lives inside the callback, not just in the helper it now delegates to.
 */
describe("ClaudeRunner canUseTool callback — AskUserQuestion guard", () => {
	let mockQuery: any;

	const defaultConfig: ClaudeRunnerConfig = {
		workingDirectory: "/tmp/test",
		cyrusHome: "/tmp/test-cyrus-home",
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockQuery = vi.mocked(query);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	function question() {
		return {
			question: "Which database should we use?",
			header: "DB",
			options: [
				{ label: "Postgres", description: "Use Postgres" },
				{ label: "MySQL", description: "Use MySQL" },
			],
			multiSelect: false,
		};
	}

	/**
	 * Constructs a runner with `onAskUserQuestion` configured (so
	 * `createCanUseToolCallback()` wires up `this.canUseToolCallback`), starts
	 * a session so `sessionInfo.sessionId` is populated from the first
	 * message (mirrors the "allowedTools widening" tests' construction
	 * pattern), then returns the real `canUseTool` callback the SDK
	 * `query()` call was given.
	 */
	async function startRunnerAndGetCanUseTool(
		onAskUserQuestion: ReturnType<typeof vi.fn>,
	): Promise<CanUseTool> {
		const runner = new ClaudeRunner({
			...defaultConfig,
			onAskUserQuestion,
		});

		mockQuery.mockImplementation(async function* () {
			yield {
				type: "assistant",
				message: { content: [{ type: "text", text: "ok" }] },
				parent_tool_use_id: null,
				session_id: "test-session",
			} as any;
		});

		await runner.start("hello");

		const call = mockQuery.mock.calls[0][0];
		const canUseTool: CanUseTool | undefined = call.options.canUseTool;
		expect(canUseTool).toBeDefined();
		return canUseTool as CanUseTool;
	}

	const signal = new AbortController().signal;

	it("denies a non-array/missing 'questions' field with the byte-identical 'required' message", async () => {
		const onAskUserQuestion = vi.fn();
		const canUseTool = await startRunnerAndGetCanUseTool(onAskUserQuestion);

		const result = await canUseTool(
			"AskUserQuestion",
			{},
			{ signal, toolUseID: "tool_1" },
		);

		expect(result).toEqual({
			behavior: "deny",
			message: "Invalid AskUserQuestion input: 'questions' array is required",
		});
		expect(result).not.toHaveProperty("interrupt");
		expect(onAskUserQuestion).not.toHaveBeenCalled();
	});

	it("denies an empty 'questions' array with the byte-identical 'one at a time' message", async () => {
		const onAskUserQuestion = vi.fn();
		const canUseTool = await startRunnerAndGetCanUseTool(onAskUserQuestion);

		const result = await canUseTool(
			"AskUserQuestion",
			{ questions: [] },
			{ signal, toolUseID: "tool_2" },
		);

		expect(result).toEqual({
			behavior: "deny",
			message:
				"Only one question at a time is supported. Please ask each question separately.",
		});
		expect(result).not.toHaveProperty("interrupt");
		expect(onAskUserQuestion).not.toHaveBeenCalled();
	});

	it("denies a 2-question array with the byte-identical 'one at a time' message and does not call onAskUserQuestion", async () => {
		const onAskUserQuestion = vi.fn();
		const canUseTool = await startRunnerAndGetCanUseTool(onAskUserQuestion);

		const result = await canUseTool(
			"AskUserQuestion",
			{ questions: [question(), question()] },
			{ signal, toolUseID: "tool_3" },
		);

		expect(result).toEqual({
			behavior: "deny",
			message:
				"Only one question at a time is supported. Please ask each question separately.",
		});
		expect(result).not.toHaveProperty("interrupt");
		expect(onAskUserQuestion).not.toHaveBeenCalled();
	});

	it("logs a warning for the multi-question case (preserves operational visibility)", async () => {
		const onAskUserQuestion = vi.fn();
		const warnSpy = vi.fn();
		const logger = createLogger({ component: "ClaudeRunner" });
		logger.warn = warnSpy;
		const runner = new ClaudeRunner({
			...defaultConfig,
			onAskUserQuestion,
			logger,
		});

		mockQuery.mockImplementation(async function* () {
			yield {
				type: "assistant",
				message: { content: [{ type: "text", text: "ok" }] },
				parent_tool_use_id: null,
				session_id: "test-session",
			} as any;
		});
		await runner.start("hello");

		const call = mockQuery.mock.calls[0][0];
		const canUseTool: CanUseTool = call.options.canUseTool;

		await canUseTool(
			"AskUserQuestion",
			{ questions: [question(), question(), question()] },
			{ signal, toolUseID: "tool_4" },
		);

		expect(warnSpy).toHaveBeenCalledWith(
			"Rejecting AskUserQuestion with 3 questions (only 1 allowed)",
		);
	});

	it("allows a single valid question and delegates to onAskUserQuestion", async () => {
		const onAskUserQuestion = vi.fn().mockResolvedValue({
			answered: true,
			answers: { "Which database should we use?": "Postgres" },
		});
		const canUseTool = await startRunnerAndGetCanUseTool(onAskUserQuestion);

		const singleQuestion = question();
		const result = await canUseTool(
			"AskUserQuestion",
			{ questions: [singleQuestion] },
			{ signal, toolUseID: "tool_5" },
		);

		expect(onAskUserQuestion).toHaveBeenCalledTimes(1);
		expect(onAskUserQuestion).toHaveBeenCalledWith(
			{ questions: [singleQuestion] },
			"test-session",
			signal,
		);
		expect(result).toEqual({
			behavior: "allow",
			updatedInput: {
				questions: [singleQuestion],
				answers: { "Which database should we use?": "Postgres" },
			},
		});
	});

	it("allows non-AskUserQuestion tools without invoking the guard", async () => {
		const onAskUserQuestion = vi.fn();
		const canUseTool = await startRunnerAndGetCanUseTool(onAskUserQuestion);

		const result = await canUseTool(
			"Bash",
			{ command: "ls" },
			{ signal, toolUseID: "tool_6" },
		);

		expect(result).toEqual({
			behavior: "allow",
			updatedInput: { command: "ls" },
		});
		expect(onAskUserQuestion).not.toHaveBeenCalled();
	});
});
