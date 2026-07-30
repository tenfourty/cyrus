import { AgentSessionStatus } from "cyrus-core";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import { AutoResumeOrchestrator } from "../src/auto-resume/AutoResumeOrchestrator";
import { AttemptBudgetFilter } from "../src/auto-resume/filters/AttemptBudgetFilter";
import { StatusActiveFilter } from "../src/auto-resume/filters/StatusActiveFilter";
import { StopIntentFilter } from "../src/auto-resume/filters/StopIntentFilter";
import type { AutoResumeConfig } from "../src/auto-resume/types";

const config: AutoResumeConfig = {
	concurrency: 2,
	staggerMs: [0, 0],
	maxAgeMs: 0,
	maxAttempts: 3,
	holdLabel: "",
};

describe("AgentSessionManager stop-intent persistence", () => {
	let manager: AgentSessionManager;
	const sessionId = "session-stop-intent";
	const issueId = "issue-stop-intent";

	beforeEach(() => {
		manager = new AgentSessionManager();
		manager.createCyrusAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "TEST-1",
				title: "Stop intent",
				description: "test",
				branchName: "test-1",
			},
			{ path: "/tmp/workspace", isGitWorktree: false },
		);
	});

	it("stamps stopRequestedAt on the session when a stop is requested", () => {
		expect(manager.getSession(sessionId)?.stopRequestedAt).toBeUndefined();

		manager.requestSessionStop(sessionId);

		expect(manager.getSession(sessionId)?.stopRequestedAt).toBeTypeOf("number");
	});

	it("keeps the stamp in serialized state so it survives a restart", () => {
		manager.requestSessionStop(sessionId);

		const serialized = manager.serializeState();
		expect(serialized.sessions[sessionId].stopRequestedAt).toBeTypeOf("number");

		const restored = new AgentSessionManager();
		restored.restoreState(serialized.sessions, serialized.entries);
		expect(restored.getSession(sessionId)?.stopRequestedAt).toBeTypeOf(
			"number",
		);
	});

	it("clears the stamp when the user sends a fresh prompt", () => {
		manager.requestSessionStop(sessionId);
		manager.clearStopIntent(sessionId);

		expect(manager.getSession(sessionId)?.stopRequestedAt).toBeUndefined();
	});

	it("does NOT respawn a stopped session whose status is still Active", async () => {
		// Reproduces the real shape: the stop force-kills the runner, the SDK
		// throws AbortError, no result message is emitted, so nothing flips
		// status. `EdgeWorker.stop()` then saves this — Active — to disk.
		manager.requestSessionStop(sessionId);
		expect(manager.getSession(sessionId)?.status).toBe(
			AgentSessionStatus.Active,
		);

		// Round-trip through persistence, exactly as a restart would.
		const serialized = manager.serializeState();
		const afterRestart = new AgentSessionManager();
		afterRestart.restoreState(serialized.sessions, serialized.entries);

		const resumed: string[] = [];
		const summary = await new AutoResumeOrchestrator({
			sessions: () => afterRestart.getAllSessions(),
			repositoryFor: () => ({ autoResumeOnStartup: true }) as any,
			fetchIssueState: async () => ({ stateType: "started", labels: [] }),
			resumeSession: async (s) => {
				resumed.push(s.id);
			},
			notifyResumed: async () => {},
			notifyRetired: async () => {},
			retireSession: async () => {},
			logger: console as any,
			config,
			filters: [
				new StatusActiveFilter(),
				new StopIntentFilter(),
				new AttemptBudgetFilter(),
			],
			sleep: async () => {},
			random: () => 0,
		}).run();

		expect(resumed).toEqual([]);
		expect(summary.resumed).toEqual([]);
		expect(summary.skipped).toEqual([{ sessionId, reason: "user-stopped" }]);
	});

	it("respawns the session again once the user re-prompts it", async () => {
		manager.requestSessionStop(sessionId);
		manager.clearStopIntent(sessionId);

		const serialized = manager.serializeState();
		const afterRestart = new AgentSessionManager();
		afterRestart.restoreState(serialized.sessions, serialized.entries);

		const resumed: string[] = [];
		await new AutoResumeOrchestrator({
			sessions: () => afterRestart.getAllSessions(),
			repositoryFor: () => ({ autoResumeOnStartup: true }) as any,
			fetchIssueState: async () => ({ stateType: "started", labels: [] }),
			resumeSession: async (s) => {
				resumed.push(s.id);
			},
			notifyResumed: async () => {},
			notifyRetired: async () => {},
			retireSession: async () => {},
			logger: console as any,
			config,
			filters: [
				new StatusActiveFilter(),
				new StopIntentFilter(),
				new AttemptBudgetFilter(),
			],
			sleep: async () => {},
			random: () => 0,
		}).run();

		expect(resumed).toEqual([sessionId]);
	});

	it("counts and clears auto-resume attempts on the persisted session", () => {
		manager.recordAutoResumeAttempt(sessionId);
		manager.recordAutoResumeAttempt(sessionId);
		expect(manager.getSession(sessionId)?.autoResumeAttempts).toBe(2);

		expect(
			manager.serializeState().sessions[sessionId].autoResumeAttempts,
		).toBe(2);

		manager.clearAutoResumeAttempts(sessionId);
		expect(manager.getSession(sessionId)?.autoResumeAttempts).toBeUndefined();
	});

	it("is a no-op for unknown session ids", () => {
		expect(() => manager.requestSessionStop("nope")).not.toThrow();
		expect(() => manager.clearStopIntent("nope")).not.toThrow();
		expect(() => manager.recordAutoResumeAttempt("nope")).not.toThrow();
		expect(() => manager.clearAutoResumeAttempts("nope")).not.toThrow();
	});
});
