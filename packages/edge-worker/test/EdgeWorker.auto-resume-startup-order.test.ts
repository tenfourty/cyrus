import { beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

vi.mock("cyrus-claude-runner");
vi.mock("cyrus-mcp-tools");
vi.mock("cyrus-linear-event-transport");
vi.mock("@linear/sdk");
vi.mock("../src/SharedApplicationServer.js");
vi.mock("cyrus-core", async (importOriginal) => {
	const actual = (await importOriginal()) as any;
	return {
		...actual,
		PersistenceManager: vi.fn().mockImplementation(function () {
			return {
				loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
				saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
			};
		}),
	};
});

const repository: RepositoryConfig = {
	id: "test-repo",
	name: "Test Repo",
	repositoryPath: "/test/repo",
	workspaceBaseDir: "/test/workspaces",
	baseBranch: "main",
	linearWorkspaceId: "test-workspace",
	linearToken: "tok",
	isActive: true,
	allowedTools: ["Read"],
	labelPrompts: {},
	teamKeys: ["TEST"],
} as RepositoryConfig;

/**
 * The webhook server must not be accepting prompts while the auto-resume
 * drain is still spawning runners.
 *
 * Original shape of the bug: `runAutoResumeOrchestrator()` was fired
 * unawaited, then `sharedApplicationServer.start()` ran immediately. A
 * prompt arriving for a session still queued in the drain took the normal
 * resume path, so two agents ended up in the same worktree — with no
 * per-session lock anywhere to stop it.
 */
describe("EdgeWorker startup ordering — auto-resume drain vs. webhook server", () => {
	let worker: EdgeWorker;
	let events: string[];
	let releaseDrain: () => void;
	let startSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});

		const config: EdgeWorkerConfig = {
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [repository],
			handlers: {},
		} as EdgeWorkerConfig;

		worker = new EdgeWorker(config);
		events = [];

		// Neutralize the unrelated startup work so the test isolates ordering.
		const w = worker as any;
		w.defaultSkillsDeployer = {
			ensureDeployed: vi.fn().mockResolvedValue(undefined),
		};
		w.skillsPluginResolver = {
			ensureUserPluginScaffolded: vi.fn().mockResolvedValue(undefined),
		};
		w.loadPersistedState = vi.fn().mockResolvedValue(undefined);
		w.configManager = {
			on: vi.fn(),
			startConfigWatcher: vi.fn(),
			stop: vi.fn().mockResolvedValue(undefined),
		};
		w.initializeComponents = vi.fn().mockResolvedValue(undefined);
		w.webhookIpValidator = { isEnabled: () => false };

		startSpy = vi.fn(async () => {
			events.push("server-start");
		});
		w.sharedApplicationServer = { start: startSpy, stop: vi.fn() };

		let resolveDrain: () => void = () => {};
		const drainGate = new Promise<void>((resolve) => {
			resolveDrain = resolve;
		});
		releaseDrain = () => resolveDrain();

		w.runAutoResumeOrchestrator = vi.fn(async () => {
			events.push("drain-start");
			await drainGate;
			events.push("drain-end");
		});
	});

	it("awaits the drain before opening the webhook server", async () => {
		const started = worker.start();

		// Wait until start() has progressed as far as the drain. It never gets
		// further on its own — the drain gate is still closed.
		for (let i = 0; i < 100 && !events.includes("drain-start"); i++) {
			await new Promise((r) => setTimeout(r, 1));
		}

		expect(events).toContain("drain-start");
		expect(startSpy).not.toHaveBeenCalled();

		releaseDrain();
		await started;

		expect(events).toEqual(["drain-start", "drain-end", "server-start"]);
	});

	it("still opens the webhook server when the drain fails", async () => {
		const w = worker as any;
		w.runAutoResumeOrchestrator = vi.fn(async () => {
			events.push("drain-start");
			throw new Error("drain blew up");
		});

		await worker.start();

		expect(events).toEqual(["drain-start", "server-start"]);
	});

	it("marks the worker as stopping before awaiting anything in stop()", async () => {
		const w = worker as any;
		w.agentSessionManager = { getAllAgentRunners: () => [] };
		w.mcpConfigService = { clearAllContexts: vi.fn() };
		w.cyrusToolsMcpSessions = { removeAllListeners: vi.fn() };

		expect(w.isStopping).toBe(false);
		const stopping = worker.stop();
		// Synchronously observable: an in-flight drain polling `shouldAbort`
		// sees the flag on its very next check, not after teardown awaits.
		expect(w.isStopping).toBe(true);
		await stopping;
	});
});
