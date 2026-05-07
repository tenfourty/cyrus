/**
 * Tests for cleanupSiblingPluginsForSession.
 *
 * `resolveSiblingSkillPlugins` writes session-scoped temp plugin dirs
 * under `<cyrusHome>/sibling-plugins/<sessionId>/`. When a session ends
 * (issue marked Done/Canceled, worktree deleted), the temp dir for that
 * session must be cleaned up to prevent unbounded growth of stale plugin
 * scaffolds.
 */

import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanupSiblingPluginsForSession } from "../src/cleanupSiblingPluginsForSession.js";

describe("cleanupSiblingPluginsForSession", () => {
	let tmpRoot: string;
	let cyrusHome: string;

	beforeEach(async () => {
		tmpRoot = await mkdtemp(join(tmpdir(), "cyrus-cleanup-test-"));
		cyrusHome = join(tmpRoot, "cyrus-home");
		await mkdir(cyrusHome, { recursive: true });
	});

	it("removes the session's sibling-plugins directory if present", async () => {
		const sessionDir = join(cyrusHome, "sibling-plugins", "session-cleanup-1");
		await mkdir(join(sessionDir, "plugin-a", ".claude-plugin"), {
			recursive: true,
		});
		await writeFile(
			join(sessionDir, "plugin-a", ".claude-plugin", "plugin.json"),
			"{}",
		);

		await cleanupSiblingPluginsForSession({
			cyrusHome,
			sessionId: "session-cleanup-1",
		});

		await expect(stat(sessionDir)).rejects.toThrow();
	});

	it("is a no-op when the session's sibling-plugins directory does not exist", async () => {
		// Should not throw
		await expect(
			cleanupSiblingPluginsForSession({
				cyrusHome,
				sessionId: "session-never-had-plugins",
			}),
		).resolves.toBeUndefined();
	});

	it("does not touch sibling-plugins for OTHER sessions", async () => {
		const dirA = join(cyrusHome, "sibling-plugins", "session-A");
		const dirB = join(cyrusHome, "sibling-plugins", "session-B");
		await mkdir(dirA, { recursive: true });
		await mkdir(dirB, { recursive: true });

		await cleanupSiblingPluginsForSession({
			cyrusHome,
			sessionId: "session-A",
		});

		await expect(stat(dirA)).rejects.toThrow();
		// session-B remains
		const statB = await stat(dirB);
		expect(statB.isDirectory()).toBe(true);
	});

	it("removes the directory recursively, including nested manifest files and symlinks", async () => {
		const sessionDir = join(cyrusHome, "sibling-plugins", "session-deep");
		const pluginA = join(sessionDir, "plugin-a");
		await mkdir(join(pluginA, ".claude-plugin"), { recursive: true });
		await writeFile(
			join(pluginA, ".claude-plugin", "plugin.json"),
			'{"name":"plugin-a"}',
		);
		// Simulate a symlinked skills/ dir (resolveSiblingSkillPlugins creates one)
		const realSkillsDir = join(tmpRoot, "real-sibling-skills");
		await mkdir(realSkillsDir, { recursive: true });
		await writeFile(join(realSkillsDir, "marker.txt"), "hello");
		const { symlink } = await import("node:fs/promises");
		await symlink(realSkillsDir, join(pluginA, "skills"), "dir");

		await cleanupSiblingPluginsForSession({
			cyrusHome,
			sessionId: "session-deep",
		});

		await expect(stat(sessionDir)).rejects.toThrow();
		// The symlink TARGET (real dir) must NOT be deleted — only the link
		const statReal = await stat(realSkillsDir);
		expect(statReal.isDirectory()).toBe(true);
	});
});
