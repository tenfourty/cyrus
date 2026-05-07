/**
 * Prompt Assembly Tests - Multi-Repo Navigation Guidance
 *
 * When a session spans multiple repositories, the user prompt must include
 * a `<multi_repo_navigation>` guidance block that tells the agent:
 *  - Which worktree is primary (its cwd)
 *  - All other worktree paths it has access to
 *  - How to run commands against non-primary worktrees (cd / git -C)
 *
 * Single-repo sessions must NOT emit the block (it would be misleading).
 */

import { describe, it } from "vitest";
import { createTestWorker, scenario } from "./prompt-assembly-utils.js";

describe("Prompt Assembly - Multi-Repo Navigation", () => {
	it("emits <multi_repo_navigation> with primary + sibling worktrees for a multi-repo session", async () => {
		const repoA = {
			id: "repo-cove-uuid",
			name: "cove",
			repositoryPath: "/src/cove",
			baseBranch: "main",
			linearWorkspaceId: "ws-1",
			workspaceBaseDir: "/test/workspaces",
		};
		const repoB = {
			id: "repo-cove-ovh-uuid",
			name: "cove-ovh",
			repositoryPath: "/src/cove-ovh",
			baseBranch: "main",
			linearWorkspaceId: "ws-1",
			workspaceBaseDir: "/test/workspaces",
		};

		const worker = createTestWorker([repoA, repoB]);

		const session = {
			issueId: "nav0001-0000-0000-0000-000000000001",
			workspace: {
				path: "/worktrees/CEE-200",
				repoPaths: {
					"repo-cove-uuid": "/worktrees/CEE-200/cove",
					"repo-cove-ovh-uuid": "/worktrees/CEE-200/cove-ovh",
				},
			},
			metadata: {},
		};

		const issue = {
			id: "nav0001-0000-0000-0000-000000000001",
			identifier: "CEE-200",
			title: "Cross-repo work",
			description: "Touch both repos",
		};

		await scenario(worker)
			.newSession()
			.assignmentBased()
			.withSession(session)
			.withIssue(issue)
			.withRepositories([repoA, repoB])
			.withUserComment("")
			.withLabels()
			.expectUserPrompt(`<repositories>
  <repository name="cove">
    <working_directory>/worktrees/CEE-200/cove</working_directory>
    <base_branch>main</base_branch>
  </repository>
  <repository name="cove-ovh">
    <working_directory>/worktrees/CEE-200/cove-ovh</working_directory>
    <base_branch>main</base_branch>
  </repository>
</repositories>

<linear_issue>
  <id>nav0001-0000-0000-0000-000000000001</id>
  <identifier>CEE-200</identifier>
  <title>Cross-repo work</title>
  <description>
Touch both repos
  </description>
  <state>Unknown</state>
  <priority>None</priority>
  <url></url>
  <assignee>
    <linear_display_name></linear_display_name>
    <linear_profile_url></linear_profile_url>
    <github_username></github_username>
    <github_user_id></github_user_id>
    <github_noreply_email></github_noreply_email>
  </assignee>
</linear_issue>

<linear_comments>
No comments yet.
</linear_comments>

<multi_repo_navigation>
This session spans MULTIPLE repositories. Each repo has its own worktree:
  - cove (primary, your cwd): /worktrees/CEE-200/cove
  - cove-ovh: /worktrees/CEE-200/cove-ovh

Your default cwd is the primary worktree. To run commands against a non-primary repo,
either \`cd\` into its worktree or use \`git -C <path>\` for git operations. Each repo
has its own branch (same name across repos) and may require its own verification
commands. When committing, treat each worktree independently — open one PR/MR per
repo that has changes; not every issue requires changes in every repo.
</multi_repo_navigation>`)
			.expectPromptType("fallback")
			.expectComponents("issue-context")
			.verify();
	});

	it("does NOT emit <multi_repo_navigation> for a single-repo session", async () => {
		const worker = createTestWorker();

		const session = {
			issueId: "nav0002-0000-0000-0000-000000000002",
			workspace: { path: "/worktrees/CEE-201" },
			metadata: {},
		};

		const issue = {
			id: "nav0002-0000-0000-0000-000000000002",
			identifier: "CEE-201",
			title: "Single repo",
			description: "Just one repo",
		};

		const repository = {
			id: "repo-solo-uuid",
			name: "cove",
			path: "/worktrees/CEE-201",
		};

		await scenario(worker)
			.newSession()
			.assignmentBased()
			.withSession(session)
			.withIssue(issue)
			.withRepository(repository)
			.withUserComment("")
			.withLabels()
			.expectUserPrompt(`<context>
  <repository>cove</repository>
  <working_directory>/worktrees/CEE-201</working_directory>
  <base_branch>main</base_branch>
</context>

<linear_issue>
  <id>nav0002-0000-0000-0000-000000000002</id>
  <identifier>CEE-201</identifier>
  <title>Single repo</title>
  <description>
Just one repo
  </description>
  <state>Unknown</state>
  <priority>None</priority>
  <url></url>
  <assignee>
    <linear_display_name></linear_display_name>
    <linear_profile_url></linear_profile_url>
    <github_username></github_username>
    <github_user_id></github_user_id>
    <github_noreply_email></github_noreply_email>
  </assignee>
</linear_issue>

<linear_comments>
No comments yet.
</linear_comments>`)
			.expectPromptType("fallback")
			.expectComponents("issue-context")
			.verify();
	});
});
