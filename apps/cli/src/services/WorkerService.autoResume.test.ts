import type { EdgeWorkerConfig } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const constructedConfigs: EdgeWorkerConfig[] = [];

vi.mock("cyrus-edge-worker", () => {
	class FakeEdgeWorker {
		constructor(config: EdgeWorkerConfig) {
			constructedConfigs.push(config);
		}
		on() {
			return this;
		}
		setConfigPath() {}
		async start() {}
		async stop() {}
		getServerPort() {
			return 3456;
		}
	}
	return {
		EdgeWorker: FakeEdgeWorker,
		GitService: class {},
		SharedApplicationServer: class {},
	};
});

vi.mock("cyrus-slack-event-transport", () => ({
	SlackEventTransport: class {},
}));

vi.mock("cyrus-cloudflare-tunnel-client", () => ({
	getCyrusAppUrl: () => "https://example.invalid",
}));

const { WorkerService } = await import("./WorkerService.js");

const repository = {
	id: "repo-a",
	name: "Repo A",
	repositoryPath: "/tmp/repo-a",
	workspaceBaseDir: "/tmp/workspaces",
	baseBranch: "main",
	linearWorkspaceId: "ws-1",
	isActive: true,
} as any;

function makeService(edgeConfig: Record<string, unknown>) {
	const configService = {
		load: () => edgeConfig,
		getConfigPath: () => "/tmp/config.json",
	} as any;
	const gitService = { createGitWorktree: vi.fn() } as any;
	const logger = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		success: vi.fn(),
		divider: vi.fn(),
	} as any;
	return new WorkerService(
		configService,
		gitService,
		"/tmp/cyrus-home",
		logger,
		"0.0.0-test",
	);
}

/**
 * `startEdgeWorker` hand-picks fields off the loaded EdgeConfig, so anything
 * it does not explicitly name never reaches EdgeWorker. `autoResume` was
 * declared on the schema and read by EdgeWorker but never copied here, which
 * made every documented `autoResume.*` knob inert: `resolveAutoResumeConfig`
 * always fell back to hardcoded defaults and `notifyOnResume: false` could
 * not be honored.
 *
 * Deleting the `autoResume: edgeConfig.autoResume` line in WorkerService must
 * fail these tests.
 */
describe("WorkerService — autoResume config pass-through", () => {
	beforeEach(() => {
		constructedConfigs.length = 0;
	});

	it("passes the whole autoResume block through to EdgeWorkerConfig", async () => {
		const autoResume = {
			concurrency: 5,
			staggerMs: [10, 20] as [number, number],
			maxAgeMs: 1000,
			maxAttempts: 7,
			holdLabel: "paused",
			notifyOnResume: false,
		};
		const service = makeService({ autoResume });

		await service.startEdgeWorker({ repositories: [repository] });

		expect(constructedConfigs).toHaveLength(1);
		expect(constructedConfigs[0].autoResume).toEqual(autoResume);
	});

	it("preserves notifyOnResume: false — the knob that is unusable when the field is dropped", async () => {
		const service = makeService({ autoResume: { notifyOnResume: false } });

		await service.startEdgeWorker({ repositories: [repository] });

		expect(constructedConfigs[0].autoResume?.notifyOnResume).toBe(false);
	});

	it("leaves autoResume undefined when the operator did not configure it", async () => {
		const service = makeService({});

		await service.startEdgeWorker({ repositories: [repository] });

		expect(constructedConfigs[0].autoResume).toBeUndefined();
	});
});
