import type { AskUserQuestionInput, IIssueTrackerService } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskUserQuestionHandler } from "../src/AskUserQuestionHandler.js";

/**
 * Tests for the bounded wait added to AskUserQuestionHandler so that a
 * headless turn whose human never answers an AskUserQuestion elicitation
 * can't hang forever. After CYRUS_ELICITATION_TIMEOUT_MS (default 15 min)
 * with no response, the handler resolves a graceful deny so the agent can
 * proceed rather than stalling until the (later) stall watchdog fires.
 */
describe("AskUserQuestionHandler timeout", () => {
	let handler: AskUserQuestionHandler;
	let mockIssueTracker: IIssueTrackerService;
	let mockGetIssueTracker: (orgId: string) => IIssueTrackerService | null;
	let mockCreateAgentActivity: ReturnType<typeof vi.fn>;

	const input: AskUserQuestionInput = {
		questions: [
			{
				question: "Which database?",
				header: "Database",
				options: [
					{ label: "PostgreSQL", description: "Open source relational DB" },
				],
				multiSelect: false,
			},
		],
	};

	beforeEach(() => {
		vi.useFakeTimers();
		mockCreateAgentActivity = vi.fn().mockResolvedValue({ success: true });
		mockIssueTracker = {
			createAgentActivity: mockCreateAgentActivity,
		} as unknown as IIssueTrackerService;

		mockGetIssueTracker = vi.fn().mockReturnValue(mockIssueTracker);

		handler = new AskUserQuestionHandler({
			getIssueTracker: mockGetIssueTracker,
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("resolves a graceful deny after the timeout elapses with no answer", async () => {
		const abortController = new AbortController();

		const resultPromise = handler.handleAskUserQuestion(
			input,
			"session-123",
			"org-123",
			abortController.signal,
		);

		// Let the elicitation post (a microtask/promise chain) settle before
		// advancing timers.
		await vi.advanceTimersByTimeAsync(0);

		await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

		const result = await resultPromise;
		expect(result.answered).toBe(false);
		expect(result.message).toMatch(/proceeding without an answer/);
		expect(handler.hasPendingQuestion("session-123")).toBe(false);
	});

	it("still resolves normally on an answer and clears the timeout timer (no double resolve)", async () => {
		const abortController = new AbortController();

		const resultPromise = handler.handleAskUserQuestion(
			input,
			"session-123",
			"org-123",
			abortController.signal,
		);

		await vi.advanceTimersByTimeAsync(0);

		const handled = handler.handleUserResponse("session-123", "PostgreSQL");
		expect(handled).toBe(true);

		const result = await resultPromise;
		expect(result.answered).toBe(true);
		expect(result.answers).toEqual({ "Which database?": "PostgreSQL" });

		// Advancing time past where the timeout would have fired must not
		// throw or attempt to resolve/settle the already-settled promise
		// again.
		await expect(
			vi.advanceTimersByTimeAsync(15 * 60 * 1000),
		).resolves.not.toThrow();
	});

	it("still resolves with cancellation on abort and clears the timeout timer", async () => {
		const abortController = new AbortController();

		const resultPromise = handler.handleAskUserQuestion(
			input,
			"session-123",
			"org-123",
			abortController.signal,
		);

		await vi.advanceTimersByTimeAsync(0);

		abortController.abort();

		const result = await resultPromise;
		expect(result.answered).toBe(false);
		expect(result.message).toBe("Operation was cancelled");

		await expect(
			vi.advanceTimersByTimeAsync(15 * 60 * 1000),
		).resolves.not.toThrow();
	});

	it("treats a late webhook answer arriving after the timeout as a safe no-op", async () => {
		const abortController = new AbortController();

		const resultPromise = handler.handleAskUserQuestion(
			input,
			"session-123",
			"org-123",
			abortController.signal,
		);

		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
		await resultPromise;

		// The pending entry was already deleted by the timeout; a late
		// webhook answer must not throw and must report "not handled".
		let handled: boolean | undefined;
		expect(() => {
			handled = handler.handleUserResponse("session-123", "PostgreSQL");
		}).not.toThrow();
		expect(handled).toBe(false);
	});

	describe("custom timeout via CYRUS_ELICITATION_TIMEOUT_MS", () => {
		afterEach(() => {
			vi.unstubAllEnvs();
			vi.resetModules();
		});

		it("uses the configured timeout instead of the 15-minute default", async () => {
			vi.stubEnv("CYRUS_ELICITATION_TIMEOUT_MS", "5000");
			vi.resetModules();

			const { AskUserQuestionHandler: FreshAskUserQuestionHandler } =
				await import("../src/AskUserQuestionHandler.js");

			const freshHandler = new FreshAskUserQuestionHandler({
				getIssueTracker: mockGetIssueTracker,
			});

			const abortController = new AbortController();
			const resultPromise = freshHandler.handleAskUserQuestion(
				input,
				"session-123",
				"org-123",
				abortController.signal,
			);

			await vi.advanceTimersByTimeAsync(0);

			// Just shy of the configured 5s timeout: still pending.
			await vi.advanceTimersByTimeAsync(4999);
			expect(freshHandler.hasPendingQuestion("session-123")).toBe(true);

			// Crossing the configured timeout resolves the graceful deny.
			await vi.advanceTimersByTimeAsync(1);
			const result = await resultPromise;
			expect(result.answered).toBe(false);
			expect(result.message).toMatch(/proceeding without an answer/);
		});
	});
});
