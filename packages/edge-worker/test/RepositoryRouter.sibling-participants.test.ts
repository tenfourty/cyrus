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
			const repoA = buildRepo("repo-a", {
				projectKeys: ["RepoA"],
				siblingParticipants: ["repo-b"],
			});
			const repoB = buildRepo("repo-b");

			const { router } = buildRouter({ issueProject: "RepoA" });
			const result = await router.determineRepositoryForWebhook(
				buildWebhook(),
				[repoA, repoB],
			);

			expect(result.type).toBe("selected");
			if (result.type !== "selected") return;
			expect(result.repositories.map((r) => r.id)).toEqual([
				"repo-a",
				"repo-b",
			]);
		});

		it("returns only the primary when siblingParticipants is unset", async () => {
			const repoA = buildRepo("repo-a", { projectKeys: ["RepoA"] });
			const repoB = buildRepo("repo-b");

			const { router } = buildRouter({ issueProject: "RepoA" });
			const result = await router.determineRepositoryForWebhook(
				buildWebhook(),
				[repoA, repoB],
			);

			expect(result.type).toBe("selected");
			if (result.type !== "selected") return;
			expect(result.repositories.map((r) => r.id)).toEqual(["repo-a"]);
		});

		it("silently skips sibling IDs that do not resolve to a registered repo", async () => {
			const repoA = buildRepo("repo-a", {
				projectKeys: ["RepoA"],
				siblingParticipants: ["repo-b", "ghost-repo"],
			});
			const repoB = buildRepo("repo-b");

			const { router } = buildRouter({ issueProject: "RepoA" });
			const result = await router.determineRepositoryForWebhook(
				buildWebhook(),
				[repoA, repoB],
			);

			expect(result.type).toBe("selected");
			if (result.type !== "selected") return;
			expect(result.repositories.map((r) => r.id)).toEqual([
				"repo-a",
				"repo-b",
			]);
		});
	});

	describe("label-based routing", () => {
		it("appends siblings to the label-matched primary", async () => {
			const repoA = buildRepo("repo-a", {
				routingLabels: ["repo:repo-a"],
				siblingParticipants: ["repo-b"],
			});
			const repoB = buildRepo("repo-b");

			const { router } = buildRouter({ issueLabels: ["repo:repo-a"] });
			const result = await router.determineRepositoryForWebhook(
				buildWebhook(),
				[repoA, repoB],
			);

			expect(result.type).toBe("selected");
			if (result.type !== "selected") return;
			expect(result.repositories.map((r) => r.id)).toEqual([
				"repo-a",
				"repo-b",
			]);
		});
	});

	describe("team-based routing", () => {
		it("appends siblings to the team-matched primary", async () => {
			const repoA = buildRepo("repo-a", {
				teamKeys: ["REPOA"],
				siblingParticipants: ["repo-b"],
			});
			const repoB = buildRepo("repo-b");

			const { router } = buildRouter({});
			const result = await router.determineRepositoryForWebhook(
				buildWebhook({ teamKey: "REPOA" }),
				[repoA, repoB],
			);

			expect(result.type).toBe("selected");
			if (result.type !== "selected") return;
			expect(result.repositories.map((r) => r.id)).toEqual([
				"repo-a",
				"repo-b",
			]);
		});
	});

	describe("description-tag routing (explicit override)", () => {
		it("does NOT augment with siblingParticipants when user supplied [repo=...] tag", async () => {
			const repoA = buildRepo("repo-a", {
				projectKeys: ["RepoA"],
				siblingParticipants: ["repo-b", "repo-deploy"],
			});
			const repoB = buildRepo("repo-b");
			const repoDeploy = buildRepo("repo-deploy");

			const { router } = buildRouter({
				issueProject: "RepoA",
				issueDescription: "[repo=repo-a] only this one please",
			});
			const result = await router.determineRepositoryForWebhook(
				buildWebhook(),
				[repoA, repoB, repoDeploy],
			);

			expect(result.type).toBe("selected");
			if (result.type !== "selected") return;
			// Tag explicitly named only `repo-a` — siblings must NOT be appended
			expect(result.repositories.map((r) => r.id)).toEqual(["repo-a"]);
		});

		it("resolves a comma-separated bracketed tag [repo=a,b] to both named repos", async () => {
			// Regression test: the bracketed tag regex must accept a comma in its
			// character class, or a multi-repo bracketed tag silently matches
			// nothing and the issue falls through to catch-all routing instead
			// of the two repos the tag actually named.
			const repoA = buildRepo("repo-a", { projectKeys: ["RepoA"] });
			const repoB = buildRepo("repo-b");
			const repoDeploy = buildRepo("repo-deploy");

			const { router } = buildRouter({
				issueDescription: "[repo=repo-b,repo-deploy] spans two repos",
			});
			const result = await router.determineRepositoryForWebhook(
				buildWebhook(),
				[repoA, repoB, repoDeploy],
			);

			expect(result.type).toBe("selected");
			if (result.type !== "selected") return;
			expect(result.repositories.map((r) => r.id)).toEqual([
				"repo-b",
				"repo-deploy",
			]);
		});
	});

	describe("deduplication", () => {
		it("does not duplicate a sibling that the routing path already returned", async () => {
			// Both repo-a and repo-b have label `shared` — both match label routing.
			// repo-a also lists repo-b as a sibling. Result must contain each once.
			const repoA = buildRepo("repo-a", {
				routingLabels: ["shared"],
				siblingParticipants: ["repo-b"],
			});
			const repoB = buildRepo("repo-b", { routingLabels: ["shared"] });

			const { router } = buildRouter({ issueLabels: ["shared"] });
			const result = await router.determineRepositoryForWebhook(
				buildWebhook(),
				[repoA, repoB],
			);

			expect(result.type).toBe("selected");
			if (result.type !== "selected") return;
			expect(result.repositories.map((r) => r.id)).toEqual([
				"repo-a",
				"repo-b",
			]);
		});
	});
});
