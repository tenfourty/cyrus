/**
 * Tests for resolveSiblingSkillPlugins.
 *
 * Tier 1.5: when a session spans multiple worktrees, sibling worktrees may
 * carry a `.claude/skills/<name>/SKILL.md` layout that the agent should be
 * able to invoke. claude-agent-sdk loads project-layer skills only from the
 * cwd's `.claude/`, so sibling skills are invisible by default.
 *
 * This helper bridges the gap by creating a session-scoped temp plugin
 * directory per sibling worktree (with the required `.claude-plugin/plugin.json`
 * manifest + a symlinked `skills/` pointing at the sibling's `.claude/skills/`)
 * and returning SdkPluginConfig entries the runner can load.
 */

import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSiblingSkillPlugins } from "../src/resolveSiblingSkillPlugins.js";

describe("resolveSiblingSkillPlugins", () => {
	let tmpRoot: string;
	let cyrusHome: string;

	beforeEach(async () => {
		tmpRoot = await mkdtemp(join(tmpdir(), "cyrus-sibling-plugins-test-"));
		cyrusHome = join(tmpRoot, "cyrus-home");
		await mkdir(cyrusHome, { recursive: true });
	});

	afterEach(async () => {
		// Best-effort cleanup; tests are isolated in tmpRoot
	});

	it("returns empty array when no sibling worktrees provided", async () => {
		const result = await resolveSiblingSkillPlugins({
			siblingWorktreePaths: [],
			cyrusHome,
			sessionId: "session-001",
		});
		expect(result).toEqual([]);
	});

	it("returns empty array when sibling has no .claude/skills/ directory", async () => {
		const sibling = join(tmpRoot, "sibling-no-skills");
		await mkdir(sibling, { recursive: true });

		const result = await resolveSiblingSkillPlugins({
			siblingWorktreePaths: [sibling],
			cyrusHome,
			sessionId: "session-002",
		});
		expect(result).toEqual([]);
	});

	it("returns empty array when sibling has .claude/ but skills dir is empty", async () => {
		const sibling = join(tmpRoot, "sibling-empty-skills");
		await mkdir(join(sibling, ".claude", "skills"), { recursive: true });

		const result = await resolveSiblingSkillPlugins({
			siblingWorktreePaths: [sibling],
			cyrusHome,
			sessionId: "session-003",
		});
		expect(result).toEqual([]);
	});

	it("creates a plugin dir with manifest + skills link for a sibling with one skill", async () => {
		const sibling = join(tmpRoot, "sibling-with-skill");
		const skillDir = join(sibling, ".claude", "skills", "deploy-runbook");
		await mkdir(skillDir, { recursive: true });
		await writeFile(
			join(skillDir, "SKILL.md"),
			"---\nname: deploy-runbook\ndescription: ovh deploy steps\n---\nsteps...",
		);

		const result = await resolveSiblingSkillPlugins({
			siblingWorktreePaths: [sibling],
			cyrusHome,
			sessionId: "session-004",
		});

		expect(result).toHaveLength(1);
		expect(result[0]!.type).toBe("local");

		// Plugin path should be inside cyrusHome/sibling-plugins/<sessionId>/...
		expect(result[0]!.path).toContain(cyrusHome);
		expect(result[0]!.path).toContain("sibling-plugins");
		expect(result[0]!.path).toContain("session-004");

		// Plugin manifest must exist at the returned path
		const manifestPath = join(result[0]!.path, ".claude-plugin", "plugin.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
		expect(manifest.name).toBeTruthy();
		expect(manifest.description).toBeTruthy();

		// skills/ inside plugin path resolves to sibling's skill (via symlink or copy)
		const skillFile = join(
			result[0]!.path,
			"skills",
			"deploy-runbook",
			"SKILL.md",
		);
		const content = await readFile(skillFile, "utf-8");
		expect(content).toContain("deploy-runbook");
		expect(content).toContain("ovh deploy steps");
	});

	it("returns one plugin entry per sibling that has skills", async () => {
		const sibA = join(tmpRoot, "sibling-a");
		const sibB = join(tmpRoot, "sibling-b");
		const sibC = join(tmpRoot, "sibling-c");
		await mkdir(join(sibA, ".claude", "skills", "skill-a"), {
			recursive: true,
		});
		await writeFile(
			join(sibA, ".claude", "skills", "skill-a", "SKILL.md"),
			"a",
		);
		// sibB has no .claude
		await mkdir(sibB, { recursive: true });
		await mkdir(join(sibC, ".claude", "skills", "skill-c"), {
			recursive: true,
		});
		await writeFile(
			join(sibC, ".claude", "skills", "skill-c", "SKILL.md"),
			"c",
		);

		const result = await resolveSiblingSkillPlugins({
			siblingWorktreePaths: [sibA, sibB, sibC],
			cyrusHome,
			sessionId: "session-005",
		});

		expect(result).toHaveLength(2);
		// Verify each plugin path is unique
		const paths = result.map((p) => p.path);
		expect(new Set(paths).size).toBe(2);
	});

	it("plugin manifest names the sibling worktree clearly so conflicts are debuggable", async () => {
		const sibling = join(tmpRoot, "cove-ovh-worktree");
		await mkdir(join(sibling, ".claude", "skills", "deploy"), {
			recursive: true,
		});
		await writeFile(
			join(sibling, ".claude", "skills", "deploy", "SKILL.md"),
			"d",
		);

		const result = await resolveSiblingSkillPlugins({
			siblingWorktreePaths: [sibling],
			cyrusHome,
			sessionId: "session-006",
		});

		const manifestPath = join(result[0]!.path, ".claude-plugin", "plugin.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
		expect(manifest.name).toContain("sibling");
		expect(manifest.description).toMatch(/cove-ovh-worktree|sibling/i);
	});

	it("is idempotent — resolving twice with same inputs yields the same plugin path and does not error", async () => {
		const sibling = join(tmpRoot, "sibling-idempotent");
		await mkdir(join(sibling, ".claude", "skills", "demo"), {
			recursive: true,
		});
		await writeFile(
			join(sibling, ".claude", "skills", "demo", "SKILL.md"),
			"x",
		);

		const first = await resolveSiblingSkillPlugins({
			siblingWorktreePaths: [sibling],
			cyrusHome,
			sessionId: "session-007",
		});
		const second = await resolveSiblingSkillPlugins({
			siblingWorktreePaths: [sibling],
			cyrusHome,
			sessionId: "session-007",
		});

		expect(first[0]!.path).toBe(second[0]!.path);
		// Manifest still readable
		const manifestPath = join(first[0]!.path, ".claude-plugin", "plugin.json");
		const stats = await stat(manifestPath);
		expect(stats.isFile()).toBe(true);
	});
});
