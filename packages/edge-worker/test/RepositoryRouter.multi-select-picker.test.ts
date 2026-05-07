/**
 * Tests for multi-select repository picker.
 *
 * `selectRepositoriesFromResponse` parses a user reply to a repo-selection
 * elicitation. The reply may be:
 *   - A single value (repo name, GitHub URL, GitLab URL) — returns one repo
 *   - A comma-separated list of values — returns all matched repos
 *   - An unrelated free-text response — falls back to the first pending repo
 *
 * Returns null when no pending selection exists for the session.
 *
 * Existing single-select method `selectRepositoryFromResponse` continues to
 * work for backward compat (returns the first matched repo).
 */

import type { AgentSessionCreatedWebhook, RepositoryConfig } from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import {
	RepositoryRouter,
	type RepositoryRouterDeps,
} from "../src/RepositoryRouter.js";

function buildRepo(
	id: string,
	overrides: Partial<RepositoryConfig> = {},
): RepositoryConfig {
	return {
		id,
		name: id,
		repositoryPath: `/path/to/${id}`,
		baseBranch: "main",
		linearWorkspaceId: "ws-1",
		workspaceBaseDir: "/workspace",
		isActive: true,
		...overrides,
	} as RepositoryConfig;
}

function buildRouter(): RepositoryRouter {
	const deps: RepositoryRouterDeps = {
		fetchIssueLabels: vi.fn().mockResolvedValue([]),
		fetchIssueDescription: vi.fn().mockResolvedValue(undefined),
		hasActiveSession: vi.fn().mockReturnValue(false),
		getIssueTracker: vi.fn().mockReturnValue({
			fetchIssue: vi.fn(),
			createAgentActivity: vi.fn().mockResolvedValue({}),
		}),
	} as RepositoryRouterDeps;
	return new RepositoryRouter(deps);
}

async function primePendingSelection(
	router: RepositoryRouter,
	agentSessionId: string,
	repos: RepositoryConfig[],
): Promise<void> {
	const webhook = {
		action: "created",
		organizationId: "ws-1",
		agentSession: {
			id: agentSessionId,
			issue: {
				id: "issue-1",
				identifier: "TEST-1",
				team: { key: "TEST" },
			},
			comment: null,
		},
		guidance: [],
	} as unknown as AgentSessionCreatedWebhook;
	await router.elicitUserRepositorySelection(webhook, repos);
}

describe("RepositoryRouter.selectRepositoriesFromResponse — multi-select", () => {
	it("returns an array with one repo when the response matches a single repo by name", async () => {
		const router = buildRouter();
		const repoA = buildRepo("repoA");
		const coveOvh = buildRepo("repoB");
		await primePendingSelection(router, "session-1", [repoA, coveOvh]);

		const result = await router.selectRepositoriesFromResponse(
			"session-1",
			"repoA",
		);

		expect(result).not.toBeNull();
		expect(result!.map((r) => r.id)).toEqual(["repoA"]);
	});

	it("returns an array of all matched repos when the response is comma-separated", async () => {
		const router = buildRouter();
		const repoA = buildRepo("repoA");
		const coveOvh = buildRepo("repoB");
		const coveDeploy = buildRepo("repoDeploy");
		await primePendingSelection(router, "session-2", [
			repoA,
			coveOvh,
			coveDeploy,
		]);

		const result = await router.selectRepositoriesFromResponse(
			"session-2",
			"repoA, repoB",
		);

		expect(result).not.toBeNull();
		expect(result!.map((r) => r.id)).toEqual(["repoA", "repoB"]);
	});

	it("matches by GitHub URL in addition to name", async () => {
		const router = buildRouter();
		const repoA = buildRepo("repoA", {
			githubUrl: "https://github.com/gg/repoA",
		});
		const coveOvh = buildRepo("repoB", {
			gitlabUrl: "https://gitlab.example/sre/repoB",
		});
		await primePendingSelection(router, "session-3", [repoA, coveOvh]);

		const result = await router.selectRepositoriesFromResponse(
			"session-3",
			"https://github.com/gg/repoA, https://gitlab.example/sre/repoB",
		);

		expect(result).not.toBeNull();
		expect(result!.map((r) => r.id)).toEqual(["repoA", "repoB"]);
	});

	it("returns only the matched repos when some comma-separated values are unknown", async () => {
		const router = buildRouter();
		const repoA = buildRepo("repoA");
		const coveOvh = buildRepo("repoB");
		await primePendingSelection(router, "session-4", [repoA, coveOvh]);

		const result = await router.selectRepositoriesFromResponse(
			"session-4",
			"repoA, made-up-repo, repoB",
		);

		expect(result).not.toBeNull();
		expect(result!.map((r) => r.id)).toEqual(["repoA", "repoB"]);
	});

	it("falls back to the first pending repo when the response matches nothing", async () => {
		const router = buildRouter();
		const repoA = buildRepo("repoA");
		const coveOvh = buildRepo("repoB");
		await primePendingSelection(router, "session-5", [repoA, coveOvh]);

		const result = await router.selectRepositoriesFromResponse(
			"session-5",
			"please just do whatever",
		);

		expect(result).not.toBeNull();
		expect(result!.map((r) => r.id)).toEqual(["repoA"]);
	});

	it("returns null when there is no pending selection for the session", async () => {
		const router = buildRouter();

		const result = await router.selectRepositoriesFromResponse(
			"unknown-session",
			"repoA",
		);

		expect(result).toBeNull();
	});

	it("clears the pending selection after a successful match (idempotent: second call returns null)", async () => {
		const router = buildRouter();
		const repoA = buildRepo("repoA");
		await primePendingSelection(router, "session-6", [repoA]);

		const first = await router.selectRepositoriesFromResponse(
			"session-6",
			"repoA",
		);
		expect(first).not.toBeNull();

		const second = await router.selectRepositoriesFromResponse(
			"session-6",
			"repoA",
		);
		expect(second).toBeNull();
	});

	it("deduplicates if the response repeats a repo", async () => {
		const router = buildRouter();
		const repoA = buildRepo("repoA");
		const coveOvh = buildRepo("repoB");
		await primePendingSelection(router, "session-7", [repoA, coveOvh]);

		const result = await router.selectRepositoriesFromResponse(
			"session-7",
			"repoA, repoA, repoB",
		);

		expect(result).not.toBeNull();
		expect(result!.map((r) => r.id)).toEqual(["repoA", "repoB"]);
	});
});
