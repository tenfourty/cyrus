/**
 * Tests for multi-repo description-tag routing end-to-end.
 *
 * `parseRepoTagsFromDescription` already returns an array of tags, and
 * `findRepositoriesByDescriptionTag` builds a repositories array from
 * those tags. These tests assert the FULL determineRepositoryForWebhook
 * flow surfaces N>1 repos when the issue body contains `[repo=A,B]`,
 * `repos=A,B`, or multiple bracketed tags.
 *
 * Sibling-participants augmentation is intentionally suppressed for
 * description-tag routing — the tag is treated as the explicit set.
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
	const cove = buildRepo("cove");
	const coveOvh = buildRepo("cove-ovh");
	const coveDeploy = buildRepo("cove-deploy");

	it("returns all repos listed in a single comma-separated [repo=a,b] tag", async () => {
		const router = buildRouter("Fix this: [repo=cove,cove-ovh]\n\nDetails.");
		const result = await router.determineRepositoryForWebhook(buildWebhook(), [
			cove,
			coveOvh,
			coveDeploy,
		]);

		expect(result.type).toBe("selected");
		if (result.type !== "selected") return;
		expect(result.repositories.map((r) => r.id)).toEqual(["cove", "cove-ovh"]);
		expect(result.routingMethod).toBe("description-tag");
	});

	it("returns all repos listed in unbracketed `repos=a,b` syntax", async () => {
		const router = buildRouter("repos=cove,cove-ovh\n\nFix this");
		const result = await router.determineRepositoryForWebhook(buildWebhook(), [
			cove,
			coveOvh,
			coveDeploy,
		]);

		expect(result.type).toBe("selected");
		if (result.type !== "selected") return;
		expect(result.repositories.map((r) => r.id)).toEqual(["cove", "cove-ovh"]);
		expect(result.routingMethod).toBe("description-tag");
	});

	it("returns all repos when multiple separate [repo=...] tags are present", async () => {
		const router = buildRouter("[repo=cove] and also [repo=cove-deploy]");
		const result = await router.determineRepositoryForWebhook(buildWebhook(), [
			cove,
			coveOvh,
			coveDeploy,
		]);

		expect(result.type).toBe("selected");
		if (result.type !== "selected") return;
		expect(result.repositories.map((r) => r.id)).toEqual([
			"cove",
			"cove-deploy",
		]);
	});

	it("applies a single trailing #branch to all comma-separated repos in a bracketed tag", async () => {
		const router = buildRouter("[repo=cove,cove-ovh#feature-x]");
		const result = await router.determineRepositoryForWebhook(buildWebhook(), [
			cove,
			coveOvh,
		]);

		expect(result.type).toBe("selected");
		if (result.type !== "selected") return;
		expect(result.repositories.map((r) => r.id)).toEqual(["cove", "cove-ovh"]);
		expect(result.baseBranchOverrides).toBeDefined();
		expect(result.baseBranchOverrides?.get("cove")).toBe("feature-x");
		expect(result.baseBranchOverrides?.get("cove-ovh")).toBe("feature-x");
	});

	it("supports per-repo branch overrides via multiple separate bracketed tags", async () => {
		const router = buildRouter(
			"[repo=cove#feature-x] needs to be paired with [repo=cove-ovh#main]",
		);
		const result = await router.determineRepositoryForWebhook(buildWebhook(), [
			cove,
			coveOvh,
		]);

		expect(result.type).toBe("selected");
		if (result.type !== "selected") return;
		expect(result.repositories.map((r) => r.id)).toEqual(["cove", "cove-ovh"]);
		expect(result.baseBranchOverrides?.get("cove")).toBe("feature-x");
		expect(result.baseBranchOverrides?.get("cove-ovh")).toBe("main");
	});

	it("returns single repo when only one tag is supplied (backward compat)", async () => {
		const router = buildRouter("[repo=cove]");
		const result = await router.determineRepositoryForWebhook(buildWebhook(), [
			cove,
			coveOvh,
		]);

		expect(result.type).toBe("selected");
		if (result.type !== "selected") return;
		expect(result.repositories.map((r) => r.id)).toEqual(["cove"]);
	});

	it("ignores unknown repo names in the tag and returns only matched repos", async () => {
		const router = buildRouter("[repo=cove,nonexistent,cove-ovh]");
		const result = await router.determineRepositoryForWebhook(buildWebhook(), [
			cove,
			coveOvh,
		]);

		expect(result.type).toBe("selected");
		if (result.type !== "selected") return;
		expect(result.repositories.map((r) => r.id)).toEqual(["cove", "cove-ovh"]);
	});
});
