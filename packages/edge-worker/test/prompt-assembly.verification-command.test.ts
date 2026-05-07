/**
 * Prompt Assembly Tests - Per-repo verificationCommand
 *
 * Tests that a repo's `verificationCommand` is surfaced in the assembled
 * user prompt as a `<verification-command>` XML block, telling the agent
 * what test/lint commands to run when verifying changes in this repo.
 */

import { describe, it } from "vitest";
import { createTestWorker, scenario } from "./prompt-assembly-utils.js";

describe("Prompt Assembly - verificationCommand", () => {
	it("appends <verification-command> block when repository sets verificationCommand", async () => {
		const worker = createTestWorker();

		const session = {
			issueId: "v0000001-0000-0000-0000-000000000001",
			workspace: { path: "/test/repo" },
			metadata: {},
		};

		const issue = {
			id: "v0000001-0000-0000-0000-000000000001",
			identifier: "CEE-901",
			title: "Add new feature",
			description: "Build the thing",
		};

		const repository = {
			id: "repo-uuid-9999-0000-0000-000000000001",
			name: "repo-a",
			path: "/test/repo",
			verificationCommand: "cargo test && cargo clippy -- -D warnings",
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
  <repository>repo-a</repository>
  <working_directory>/test/repo</working_directory>
  <base_branch>main</base_branch>
</context>

<linear_issue>
  <id>v0000001-0000-0000-0000-000000000001</id>
  <identifier>CEE-901</identifier>
  <title>Add new feature</title>
  <description>
Build the thing
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

<verification-command repository="repo-a">
cargo test && cargo clippy -- -D warnings
</verification-command>`)
			.expectPromptType("fallback")
			.expectComponents("issue-context")
			.verify();
	});

	it("does not emit <verification-command> when repository omits verificationCommand", async () => {
		const worker = createTestWorker();

		const session = {
			issueId: "v0000002-0000-0000-0000-000000000002",
			workspace: { path: "/test/repo" },
			metadata: {},
		};

		const issue = {
			id: "v0000002-0000-0000-0000-000000000002",
			identifier: "CEE-902",
			title: "Another issue",
			description: "Different work",
		};

		const repository = {
			id: "repo-uuid-9999-0000-0000-000000000002",
			name: "repo-b",
			path: "/test/repo",
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
  <repository>repo-b</repository>
  <working_directory>/test/repo</working_directory>
  <base_branch>main</base_branch>
</context>

<linear_issue>
  <id>v0000002-0000-0000-0000-000000000002</id>
  <identifier>CEE-902</identifier>
  <title>Another issue</title>
  <description>
Different work
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

	it("emits <verification-command> per repo when only some repos set it (multi-repo)", async () => {
		const repoA = {
			id: "repo-a-9999-0000-0000-000000000001",
			name: "repo-a",
			repositoryPath: "/test/repo-a",
			baseBranch: "main",
			linearWorkspaceId: "ws-1",
			workspaceBaseDir: "/test/workspaces",
			verificationCommand: "cargo test",
		};
		const repoB = {
			id: "repo-b-9999-0000-0000-000000000002",
			name: "repo-b",
			repositoryPath: "/test/repo-b",
			baseBranch: "main",
			linearWorkspaceId: "ws-1",
			workspaceBaseDir: "/test/workspaces",
		};
		const repoC = {
			id: "repo-c-9999-0000-0000-000000000003",
			name: "repo-deploy",
			repositoryPath: "/test/repo-deploy",
			baseBranch: "main",
			linearWorkspaceId: "ws-1",
			workspaceBaseDir: "/test/workspaces",
			verificationCommand: "ansible-lint roles/",
		};

		const worker = createTestWorker([repoA, repoB, repoC]);

		const session = {
			issueId: "v0000003-0000-0000-0000-000000000003",
			workspace: { path: "/test" },
			metadata: {},
		};

		const issue = {
			id: "v0000003-0000-0000-0000-000000000003",
			identifier: "CEE-903",
			title: "Cross-repo work",
			description: "Spans repos",
		};

		await scenario(worker)
			.newSession()
			.assignmentBased()
			.withSession(session)
			.withIssue(issue)
			.withRepositories([repoA, repoB, repoC])
			.withUserComment("")
			.withLabels()
			.expectUserPrompt(`<repositories>
  <repository name="repo-a">
    <working_directory>/test/repo-a</working_directory>
    <base_branch>main</base_branch>
  </repository>
  <repository name="repo-b">
    <working_directory>/test/repo-b</working_directory>
    <base_branch>main</base_branch>
  </repository>
  <repository name="repo-deploy">
    <working_directory>/test/repo-deploy</working_directory>
    <base_branch>main</base_branch>
  </repository>
</repositories>

<linear_issue>
  <id>v0000003-0000-0000-0000-000000000003</id>
  <identifier>CEE-903</identifier>
  <title>Cross-repo work</title>
  <description>
Spans repos
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

<verification-command repository="repo-a">
cargo test
</verification-command>

<verification-command repository="repo-deploy">
ansible-lint roles/
</verification-command>`)
			.expectPromptType("fallback")
			.expectComponents("issue-context")
			.verify();
	});
});
