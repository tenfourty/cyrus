/**
 * Tests for `siblingParticipants` per-repo config field augmentation.
 *
 * When a repository is matched as primary by routing (project, label, or
 * team), any repos listed in `primary.siblingParticipants` (by repo ID)
 * are appended to the result so the session spans all of them.
 *
 * Description-tag routing (`[repo=a,b]`) is treated as an explicit
 * override and does NOT trigger sibling augmentation.
 *
 * Missing or unknown sibling IDs are silently skipped — they may refer
 * to repos in other workspaces or repos that have been removed.
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

function buildWebhook(
	overrides: Partial<{
		issueId: string;
		identifier: string;
		teamKey: string;
		workspaceId: string;
	}> = {},
): LinearAgentSessionCreatedWebhook {
	return {
		action: "created",
		organizationId: overrides.workspaceId ?? "ws-1",
		agentSession: {
			id: "session-1",
			issue: {
				id: overrides.issueId ?? "issue-1",
				identifier: overrides.identifier ?? "TEST-1",
				team: { key: overrides.teamKey ?? "TEST" },
			},
			comment: null,
		},
		guidance: [],
	} as any;
}

function buildRouter(opts: {
	issueLabels?: string[];
	issueProject?: string;
	issueDescription?: string;
}): {
	router: RepositoryRouter;
	deps: RepositoryRouterDeps;
} {
	const deps: RepositoryRouterDeps = {
		fetchIssueLabels: vi.fn().mockResolvedValue(opts.issueLabels ?? []),
		fetchIssueDescription: vi.fn().mockResolvedValue(opts.issueDescription),
		hasActiveSession: vi.fn().mockReturnValue(false),
		getIssueTracker: vi.fn().mockReturnValue({
			fetchIssue: vi.fn().mockResolvedValue({
				id: "issue-1",
				identifier: "TEST-1",
				project: opts.issueProject ? { name: opts.issueProject } : null,
			}),
		}),
	} as RepositoryRouterDeps;
	return { router: new RepositoryRouter(deps), deps };
}

describe("RepositoryRouter — siblingParticipants augmentation", () => {
	describe("project-based routing", () => {
		it("appends sibling repos to the matched primary when siblingParticipants is set", async () => {
			const cove = buildRepo("cove", {
				projectKeys: ["Cove"],
				siblingParticipants: ["cove-ovh"],
			});
			const coveOvh = buildRepo("cove-ovh");

			const { router } = buildRouter({ issueProject: "Cove" });
			const result = await router.determineRepositoryForWebhook(
				buildWebhook(),
				[cove, coveOvh],
			);

			expect(result.type).toBe("selected");
			if (result.type !== "selected") return;
			expect(result.repositories.map((r) => r.id)).toEqual([
				"cove",
				"cove-ovh",
			]);
		});

		it("returns only the primary when siblingParticipants is unset", async () => {
			const cove = buildRepo("cove", { projectKeys: ["Cove"] });
			const coveOvh = buildRepo("cove-ovh");

			const { router } = buildRouter({ issueProject: "Cove" });
			const result = await router.determineRepositoryForWebhook(
				buildWebhook(),
				[cove, coveOvh],
			);

			expect(result.type).toBe("selected");
			if (result.type !== "selected") return;
			expect(result.repositories.map((r) => r.id)).toEqual(["cove"]);
		});

		it("silently skips sibling IDs that do not resolve to a registered repo", async () => {
			const cove = buildRepo("cove", {
				projectKeys: ["Cove"],
				siblingParticipants: ["cove-ovh", "ghost-repo"],
			});
			const coveOvh = buildRepo("cove-ovh");

			const { router } = buildRouter({ issueProject: "Cove" });
			const result = await router.determineRepositoryForWebhook(
				buildWebhook(),
				[cove, coveOvh],
			);

			expect(result.type).toBe("selected");
			if (result.type !== "selected") return;
			expect(result.repositories.map((r) => r.id)).toEqual([
				"cove",
				"cove-ovh",
			]);
		});
	});

	describe("label-based routing", () => {
		it("appends siblings to the label-matched primary", async () => {
			const cove = buildRepo("cove", {
				routingLabels: ["repo:cove"],
				siblingParticipants: ["cove-ovh"],
			});
			const coveOvh = buildRepo("cove-ovh");

			const { router } = buildRouter({ issueLabels: ["repo:cove"] });
			const result = await router.determineRepositoryForWebhook(
				buildWebhook(),
				[cove, coveOvh],
			);

			expect(result.type).toBe("selected");
			if (result.type !== "selected") return;
			expect(result.repositories.map((r) => r.id)).toEqual([
				"cove",
				"cove-ovh",
			]);
		});
	});

	describe("team-based routing", () => {
		it("appends siblings to the team-matched primary", async () => {
			const cove = buildRepo("cove", {
				teamKeys: ["COVE"],
				siblingParticipants: ["cove-ovh"],
			});
			const coveOvh = buildRepo("cove-ovh");

			const { router } = buildRouter({});
			const result = await router.determineRepositoryForWebhook(
				buildWebhook({ teamKey: "COVE" }),
				[cove, coveOvh],
			);

			expect(result.type).toBe("selected");
			if (result.type !== "selected") return;
			expect(result.repositories.map((r) => r.id)).toEqual([
				"cove",
				"cove-ovh",
			]);
		});
	});

	describe("description-tag routing (explicit override)", () => {
		it("does NOT augment with siblingParticipants when user supplied [repo=...] tag", async () => {
			const cove = buildRepo("cove", {
				projectKeys: ["Cove"],
				siblingParticipants: ["cove-ovh", "cove-deploy"],
			});
			const coveOvh = buildRepo("cove-ovh");
			const coveDeploy = buildRepo("cove-deploy");

			const { router } = buildRouter({
				issueProject: "Cove",
				issueDescription: "[repo=cove] only this one please",
			});
			const result = await router.determineRepositoryForWebhook(
				buildWebhook(),
				[cove, coveOvh, coveDeploy],
			);

			expect(result.type).toBe("selected");
			if (result.type !== "selected") return;
			// Tag explicitly named only `cove` — siblings must NOT be appended
			expect(result.repositories.map((r) => r.id)).toEqual(["cove"]);
		});
	});

	describe("deduplication", () => {
		it("does not duplicate a sibling that the routing path already returned", async () => {
			// Both cove and cove-ovh have label `shared` — both match label routing.
			// cove also lists cove-ovh as a sibling. Result must contain each once.
			const cove = buildRepo("cove", {
				routingLabels: ["shared"],
				siblingParticipants: ["cove-ovh"],
			});
			const coveOvh = buildRepo("cove-ovh", { routingLabels: ["shared"] });

			const { router } = buildRouter({ issueLabels: ["shared"] });
			const result = await router.determineRepositoryForWebhook(
				buildWebhook(),
				[cove, coveOvh],
			);

			expect(result.type).toBe("selected");
			if (result.type !== "selected") return;
			expect(result.repositories.map((r) => r.id)).toEqual([
				"cove",
				"cove-ovh",
			]);
		});
	});
});
