import type { CyrusAgentSession, RepositoryConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	buildWarmupStartupOptions,
	isNoConversationFoundError,
} from "../src/warmupSession.js";

const repo = {
	id: "repoA",
	name: "Cove",
	repositoryPath: "/repos/repoA",
} as unknown as RepositoryConfig;

function makeSession(
	overrides: Partial<CyrusAgentSession> = {},
): CyrusAgentSession {
	return {
		id: "sess-1",
		claudeSessionId: "8ba65eaf-ff51-4f8b-8a7b-4fe92760aa0f",
		workspace: { path: "/root/.cyrus/worktrees/ENG-432" },
		...overrides,
	} as unknown as CyrusAgentSession;
}

const baseInput = {
	repository: repo,
	model: "claude-opus-4-8",
	mcpServers: {},
	allowedTools: [] as string[],
	disallowedTools: [] as string[],
	env: { FOO: "bar" } as Record<string, string>,
};

describe("buildWarmupStartupOptions", () => {
	it("resolves cwd to the primary repo's worktree for multi-repo workspaces", () => {
		// Regression: warmup used to pass workspace.path (the worktree ROOT),
		// but the live runner uses the primary repo subdir — so resume looked
		// under a project slug with no transcripts → "No conversation found".
		const session = makeSession({
			workspace: {
				path: "/root/.cyrus/worktrees/ENG-432",
				repoPaths: { repoA: "/root/.cyrus/worktrees/ENG-432/repoA" },
			},
		} as unknown as Partial<CyrusAgentSession>);

		const opts = buildWarmupStartupOptions({ ...baseInput, session });

		expect(opts.cwd).toBe("/root/.cyrus/worktrees/ENG-432/repoA");
	});

	it("uses workspace.path as cwd for single-repo workspaces", () => {
		const session = makeSession();
		const opts = buildWarmupStartupOptions({ ...baseInput, session });
		expect(opts.cwd).toBe("/root/.cyrus/worktrees/ENG-432");
	});

	it("matches the live runner's cwd resolution (same resolver)", async () => {
		const { resolveSessionWorkingDirectory } = await import(
			"../src/resolveSessionWorkingDirectory.js"
		);
		const session = makeSession({
			workspace: {
				path: "/ws/ENG-9",
				repoPaths: { repoA: "/ws/ENG-9/repoA" },
			},
		} as unknown as Partial<CyrusAgentSession>);
		const opts = buildWarmupStartupOptions({ ...baseInput, session });
		expect(opts.cwd).toBe(resolveSessionWorkingDirectory(session, repo));
	});

	it("passes through resume (claudeSessionId) and model", () => {
		const session = makeSession();
		const opts = buildWarmupStartupOptions({ ...baseInput, session });
		expect(opts.resume).toBe("8ba65eaf-ff51-4f8b-8a7b-4fe92760aa0f");
		expect(opts.model).toBe("claude-opus-4-8");
	});

	it("includes mcpServers/allowedTools/disallowedTools only when non-empty", () => {
		const session = makeSession();
		const withNone = buildWarmupStartupOptions({ ...baseInput, session });
		expect("mcpServers" in withNone).toBe(false);
		expect("allowedTools" in withNone).toBe(false);
		expect("disallowedTools" in withNone).toBe(false);

		const withSome = buildWarmupStartupOptions({
			...baseInput,
			session,
			mcpServers: { linear: { type: "http", url: "https://x" } } as never,
			allowedTools: ["Read(**)"],
			disallowedTools: ["Bash"],
		});
		expect(withSome.mcpServers).toEqual({
			linear: { type: "http", url: "https://x" },
		});
		expect(withSome.allowedTools).toEqual(["Read(**)"]);
		expect(withSome.disallowedTools).toEqual(["Bash"]);
	});
});

describe("isNoConversationFoundError", () => {
	it("recognizes the SDK 'No conversation found' resume failure", () => {
		const err = new Error(
			"Claude Code returned an error result: No conversation found with session ID: 8ba65eaf-ff51-4f8b-8a7b-4fe92760aa0f",
		);
		expect(isNoConversationFoundError(err)).toBe(true);
	});

	it("returns false for unrelated errors", () => {
		expect(isNoConversationFoundError(new Error("ECONNREFUSED"))).toBe(false);
	});

	it("handles non-Error values without throwing", () => {
		expect(
			isNoConversationFoundError("No conversation found with session ID: x"),
		).toBe(true);
		expect(isNoConversationFoundError(undefined)).toBe(false);
		expect(isNoConversationFoundError(null)).toBe(false);
	});
});
