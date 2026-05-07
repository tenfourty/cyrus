/**
 * Tests for multi-repo description-tag routing end-to-end.
 *
 * `parseRepoTagsFromDescription` already returns an array of tags, and
 * `findRepositoriesByDescriptionTag` builds a repositories array from
 * those tags. These tests assert the FULL determineRepositoryForWebhook
 * flow surfaces N>1 repos when the issue body contains `[repo=A,B]`,
 * `repos=A,B`, or multiple bracketed tags.
 */

import type {
	LinearAgentSessionCreatedWebhook,
	RepositoryConfig,
} from "cyrus-core";
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

function buildWebhook(): LinearAgentSessionCreatedWebhook {
	return {
		action: "created",
		organizationId: "ws-1",
		agentSession: {
			id: "session-1",
			issue: {
				id: "issue-1",
				identifier: "TEST-1",
				team: { key: "TEST" },
			},
			comment: null,
		},
		guidance: [],
	} as any;
}

function buildRouter(description: string): RepositoryRouter {
	const deps: RepositoryRouterDeps = {
		fetchIssueLabels: vi.fn().mockResolvedValue([]),
		fetchIssueDescription: vi.fn().mockResolvedValue(description),
		hasActiveSession: vi.fn().mockReturnValue(false),
		getIssueTracker: vi.fn().mockReturnValue({
			fetchIssue: vi.fn().mockResolvedValue({
				id: "issue-1",
				identifier: "TEST-1",
				project: null,
			}),
		}),
	} as RepositoryRouterDeps;
	return new RepositoryRouter(deps);
}

describe("RepositoryRouter — multi-repo description tag", () => {
	const repoA = buildRepo("repo-a");
	const repoB = buildRepo("repo-b");
	const repoDeploy = buildRepo("repo-deploy");

	it("returns all repos listed in a single comma-separated [repo=a,b] tag", async () => {
		const router = buildRouter("Fix this: [repo=repo-a,repo-b]\n\nDetails.");
		const result = await router.determineRepositoryForWebhook(buildWebhook(), [
			repoA,
			repoB,
			repoDeploy,
		]);

		expect(result.type).toBe("selected");
		if (result.type !== "selected") return;
		expect(result.repositories.map((r) => r.id)).toEqual(["repo-a", "repo-b"]);
		expect(result.routingMethod).toBe("description-tag");
	});

	it("returns all repos listed in unbracketed `repos=a,b` syntax", async () => {
		const router = buildRouter("repos=repo-a,repo-b\n\nFix this");
		const result = await router.determineRepositoryForWebhook(buildWebhook(), [
			repoA,
			repoB,
			repoDeploy,
		]);

		expect(result.type).toBe("selected");
		if (result.type !== "selected") return;
		expect(result.repositories.map((r) => r.id)).toEqual(["repo-a", "repo-b"]);
		expect(result.routingMethod).toBe("description-tag");
	});

	it("returns all repos when multiple separate [repo=...] tags are present", async () => {
		const router = buildRouter("[repo=repo-a] and also [repo=repo-deploy]");
		const result = await router.determineRepositoryForWebhook(buildWebhook(), [
			repoA,
			repoB,
			repoDeploy,
		]);

		expect(result.type).toBe("selected");
		if (result.type !== "selected") return;
		expect(result.repositories.map((r) => r.id)).toEqual([
			"repo-a",
			"repo-deploy",
		]);
	});

	it("applies a single trailing #branch to all comma-separated repos in a bracketed tag", async () => {
		const router = buildRouter("[repo=repo-a,repo-b#feature-x]");
		const result = await router.determineRepositoryForWebhook(buildWebhook(), [
			repoA,
			repoB,
		]);

		expect(result.type).toBe("selected");
		if (result.type !== "selected") return;
		expect(result.repositories.map((r) => r.id)).toEqual(["repo-a", "repo-b"]);
		expect(result.baseBranchOverrides).toBeDefined();
		expect(result.baseBranchOverrides?.get("repo-a")).toBe("feature-x");
		expect(result.baseBranchOverrides?.get("repo-b")).toBe("feature-x");
	});

	it("supports per-repo branch overrides via multiple separate bracketed tags", async () => {
		const router = buildRouter(
			"[repo=repo-a#feature-x] needs to be paired with [repo=repo-b#main]",
		);
		const result = await router.determineRepositoryForWebhook(buildWebhook(), [
			repoA,
			repoB,
		]);

		expect(result.type).toBe("selected");
		if (result.type !== "selected") return;
		expect(result.repositories.map((r) => r.id)).toEqual(["repo-a", "repo-b"]);
		expect(result.baseBranchOverrides?.get("repo-a")).toBe("feature-x");
		expect(result.baseBranchOverrides?.get("repo-b")).toBe("main");
	});

	it("returns single repo when only one tag is supplied (backward compat)", async () => {
		const router = buildRouter("[repo=repo-a]");
		const result = await router.determineRepositoryForWebhook(buildWebhook(), [
			repoA,
			repoB,
		]);

		expect(result.type).toBe("selected");
		if (result.type !== "selected") return;
		expect(result.repositories.map((r) => r.id)).toEqual(["repo-a"]);
	});

	it("ignores unknown repo names in the tag and returns only matched repos", async () => {
		const router = buildRouter("[repo=repo-a,nonexistent,repo-b]");
		const result = await router.determineRepositoryForWebhook(buildWebhook(), [
			repoA,
			repoB,
		]);

		expect(result.type).toBe("selected");
		if (result.type !== "selected") return;
		expect(result.repositories.map((r) => r.id)).toEqual(["repo-a", "repo-b"]);
	});

	it("allows a space after the comma in a bracketed tag: [repo=a, b]", async () => {
		const router = buildRouter("Fix this: [repo=repo-a, repo-b]\n\nDetails.");
		const result = await router.determineRepositoryForWebhook(buildWebhook(), [
			repoA,
			repoB,
			repoDeploy,
		]);

		expect(result.type).toBe("selected");
		if (result.type !== "selected") return;
		expect(result.repositories.map((r) => r.id)).toEqual(["repo-a", "repo-b"]);
	});

	it("allows a space after the comma in unbracketed repos=a, b syntax", async () => {
		const router = buildRouter("repos=repo-a, repo-b\n\nFix this");
		const result = await router.determineRepositoryForWebhook(buildWebhook(), [
			repoA,
			repoB,
			repoDeploy,
		]);

		expect(result.type).toBe("selected");
		if (result.type !== "selected") return;
		expect(result.repositories.map((r) => r.id)).toEqual(["repo-a", "repo-b"]);
	});

	it("allows a space after the comma together with a trailing #branch", async () => {
		const router = buildRouter("[repo=repo-a, repo-b#feature-x]");
		const result = await router.determineRepositoryForWebhook(buildWebhook(), [
			repoA,
			repoB,
		]);

		expect(result.type).toBe("selected");
		if (result.type !== "selected") return;
		expect(result.repositories.map((r) => r.id)).toEqual(["repo-a", "repo-b"]);
		expect(result.baseBranchOverrides?.get("repo-a")).toBe("feature-x");
		expect(result.baseBranchOverrides?.get("repo-b")).toBe("feature-x");
	});

	it("does not swallow the rest of the sentence after an unbracketed tag with a spaced comma", async () => {
		// Regression guard: the space-after-comma allowance must stay bounded
		// to right after a comma, or the unbracketed pattern would greedily
		// consume unrelated trailing words as part of the repo list.
		const router = buildRouter(
			"repos=repo-a, repo-b please also update the docs",
		);
		const result = await router.determineRepositoryForWebhook(buildWebhook(), [
			repoA,
			repoB,
			repoDeploy,
		]);

		expect(result.type).toBe("selected");
		if (result.type !== "selected") return;
		expect(result.repositories.map((r) => r.id)).toEqual(["repo-a", "repo-b"]);
	});
});
