import type { LinearClient } from "@linear/sdk";
import { describe, expect, it, vi } from "vitest";
import { LinearIssueTrackerService } from "../src/LinearIssueTrackerService.js";

function makeService(): {
	service: LinearIssueTrackerService;
	createAgentActivityMock: ReturnType<typeof vi.fn>;
	logger: { warn: ReturnType<typeof vi.fn> };
} {
	const createAgentActivityMock = vi.fn().mockResolvedValue({
		agentActivity: Promise.resolve({ id: "a-1" }),
		success: true,
		lastSyncId: Date.now(),
	});
	const linearClient = {
		createAgentActivity: createAgentActivityMock,
	} as unknown as LinearClient;
	const logger = {
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		withContext: function () {
			return this;
		},
	};
	const service = new LinearIssueTrackerService(
		linearClient,
		undefined,
		logger as any,
	);
	return { service, createAgentActivityMock, logger };
}

const sessionId = "session-abc";

describe("LinearIssueTrackerService — post-response turn guard", () => {
	it("does NOT warn on the first response activity for a session", async () => {
		const { service, logger } = makeService();
		await service.createAgentActivity({
			agentSessionId: sessionId,
			content: { type: "response", body: "ok" },
		});
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("WARNS when a thought is posted after a response (Linear UI state demotion risk)", async () => {
		const { service, logger } = makeService();
		await service.createAgentActivity({
			agentSessionId: sessionId,
			content: { type: "response", body: "ok" },
		});
		await service.createAgentActivity({
			agentSessionId: sessionId,
			content: { type: "thought", body: "trailing thought" },
		});
		expect(logger.warn).toHaveBeenCalledTimes(1);
		const msg = logger.warn.mock.calls[0][0] as string;
		expect(msg).toContain("'thought'");
		expect(msg).toContain(sessionId);
		expect(msg).toContain("still working");
	});

	it("WARNS when action is posted after a response", async () => {
		const { service, logger } = makeService();
		await service.createAgentActivity({
			agentSessionId: sessionId,
			content: { type: "response", body: "ok" },
		});
		await service.createAgentActivity({
			agentSessionId: sessionId,
			content: { type: "action", action: "Edit", parameter: "x" } as any,
		});
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	it("WARNS when elicitation is posted after a response", async () => {
		const { service, logger } = makeService();
		await service.createAgentActivity({
			agentSessionId: sessionId,
			content: { type: "response", body: "ok" },
		});
		await service.createAgentActivity({
			agentSessionId: sessionId,
			content: { type: "elicitation", body: "?" } as any,
		});
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	it("WARNS after an `error` closing activity too", async () => {
		const { service, logger } = makeService();
		await service.createAgentActivity({
			agentSessionId: sessionId,
			content: { type: "error", body: "oh no" },
		});
		await service.createAgentActivity({
			agentSessionId: sessionId,
			content: { type: "thought", body: "still posting" },
		});
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	it("does NOT warn after notifyTurnStarted resets the guard", async () => {
		const { service, logger } = makeService();
		await service.createAgentActivity({
			agentSessionId: sessionId,
			content: { type: "response", body: "ok" },
		});
		service.notifyTurnStarted(sessionId);
		await service.createAgentActivity({
			agentSessionId: sessionId,
			content: { type: "thought", body: "new turn thought" },
		});
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("guard is per-session — response on session A does not warn for session B activities", async () => {
		const { service, logger } = makeService();
		await service.createAgentActivity({
			agentSessionId: "session-A",
			content: { type: "response", body: "ok" },
		});
		await service.createAgentActivity({
			agentSessionId: "session-B",
			content: { type: "thought", body: "fine" },
		});
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("still posts the activity (warn-only mode, does not block)", async () => {
		const { service, createAgentActivityMock } = makeService();
		await service.createAgentActivity({
			agentSessionId: sessionId,
			content: { type: "response", body: "ok" },
		});
		await service.createAgentActivity({
			agentSessionId: sessionId,
			content: { type: "thought", body: "trailing" },
		});
		expect(createAgentActivityMock).toHaveBeenCalledTimes(2);
	});
});
