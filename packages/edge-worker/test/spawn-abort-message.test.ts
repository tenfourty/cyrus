import { describe, expect, it, vi } from "vitest";
import {
	formatSpawnAbortMessage,
	notifySpawnAbort,
} from "../src/spawn-abort-message.js";

const silentLogger: any = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	withContext: function () {
		return this;
	},
};

describe("formatSpawnAbortMessage", () => {
	it("renders a user-actionable message for session-removed", () => {
		const message = formatSpawnAbortMessage("session-removed");
		expect(message).toMatchInlineSnapshot(
			`"⚠️ Your message arrived after this session was closed (the issue moved to a terminal state). Re-open the issue or create a new one to continue."`,
		);
	});

	it("renders a user-actionable message for stop-requested", () => {
		const message = formatSpawnAbortMessage("stop-requested");
		expect(message).toMatchInlineSnapshot(
			`"⚠️ A pending stop request was honored before this prompt could start a new runner. Please resend your message to start a fresh turn."`,
		);
	});

	it("renders a user-actionable message for draining", () => {
		const message = formatSpawnAbortMessage("draining");
		expect(message).toMatchInlineSnapshot(
			`"⚠️ Cyrus is restarting and your message arrived during the shutdown window. Please resend in ~30 seconds."`,
		);
	});

	it("renders a user-actionable message for worktree-missing", () => {
		const message = formatSpawnAbortMessage("worktree-missing");
		expect(message).toMatchInlineSnapshot(
			`"⚠️ The workspace for this session is no longer on disk and was not recreated for this prompt. Please resend your message — the next prompt will recreate the workspace cleanly."`,
		);
	});
});

describe("notifySpawnAbort", () => {
	it("posts the abort message to the activity poster with the session id", async () => {
		const createResponseActivity = vi.fn().mockResolvedValue(undefined);
		const activityPoster = { createResponseActivity };

		await notifySpawnAbort({
			sessionId: "session-xyz",
			reason: "session-removed",
			activityPoster,
			logger: silentLogger,
		});

		expect(createResponseActivity).toHaveBeenCalledTimes(1);
		expect(createResponseActivity).toHaveBeenCalledWith(
			"session-xyz",
			formatSpawnAbortMessage("session-removed"),
		);
	});

	it("posts the reason-specific message for each abort reason", async () => {
		const reasons = [
			"session-removed",
			"stop-requested",
			"draining",
			"worktree-missing",
		] as const;

		for (const reason of reasons) {
			const createResponseActivity = vi.fn().mockResolvedValue(undefined);
			await notifySpawnAbort({
				sessionId: "s",
				reason,
				activityPoster: { createResponseActivity },
				logger: silentLogger,
			});
			expect(createResponseActivity).toHaveBeenCalledWith(
				"s",
				formatSpawnAbortMessage(reason),
			);
		}
	});

	it("swallows poster errors so the caller can still persist state", async () => {
		const createResponseActivity = vi
			.fn()
			.mockRejectedValue(new Error("Linear rejected: not a UUID"));
		const warnSpy = vi.fn();
		const logger = { ...silentLogger, warn: warnSpy };

		await expect(
			notifySpawnAbort({
				sessionId: "gitlab-session",
				reason: "draining",
				activityPoster: { createResponseActivity },
				logger,
			}),
		).resolves.toBeUndefined();

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0][0]).toContain("gitlab-session");
		expect(warnSpy.mock.calls[0][0]).toContain("draining");
		expect(warnSpy.mock.calls[0][0]).toContain("Linear rejected: not a UUID");
	});
});
