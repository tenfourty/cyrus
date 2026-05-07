import { createHash } from "node:crypto";
import { access, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SdkPluginConfig } from "cyrus-claude-runner";

export interface ResolveSiblingSkillPluginsInput {
	/** Absolute paths to sibling worktrees (non-primary participating repos in a multi-repo session) */
	siblingWorktreePaths: string[];
	/** Cyrus home directory (~/.cyrus) — temp plugin dirs live under <cyrusHome>/sibling-plugins/ */
	cyrusHome: string;
	/** Session identifier — temp plugin dirs are scoped per-session to keep concurrent sessions isolated */
	sessionId: string;
}

/**
 * Resolves sibling-worktree skills as Claude Agent SDK plugins.
 *
 * In a multi-repo session, only the PRIMARY worktree's project-layer
 * skills (cwd's `.claude/skills/`) are loaded by the SDK's setting-sources
 * mechanism. Sibling worktrees that carry their own `.claude/skills/<name>/`
 * are otherwise invisible to the agent.
 *
 * For each sibling worktree that contains at least one skill, this helper
 * creates a session-scoped temp plugin directory under
 * `<cyrusHome>/sibling-plugins/<sessionId>/<sanitized>/` containing:
 *   - `.claude-plugin/plugin.json` — auto-generated manifest
 *   - `skills/` — symlink to `<sibling>/.claude/skills/`
 *
 * The returned `SdkPluginConfig` entries can be passed directly to the
 * runner's `plugins` array.
 *
 * NOT covered: sibling `.claude/commands/*.md` (slash commands). The
 * Claude Agent SDK plugin format does not load commands from plugin
 * directories — commands are read from the cwd's project-layer settings
 * only. Cross-repo command discovery requires a separate mechanism.
 */
export async function resolveSiblingSkillPlugins(
	input: ResolveSiblingSkillPluginsInput,
): Promise<SdkPluginConfig[]> {
	const { siblingWorktreePaths, cyrusHome, sessionId } = input;

	const plugins: SdkPluginConfig[] = [];

	for (const sibling of siblingWorktreePaths) {
		const skillsSrc = join(sibling, ".claude", "skills");
		if (!(await hasSkills(skillsSrc))) {
			continue;
		}

		const sanitized = sanitizePathForFsName(sibling);
		const pluginRoot = join(cyrusHome, "sibling-plugins", sessionId, sanitized);

		await ensurePluginScaffold(pluginRoot, skillsSrc, basename(sibling));

		plugins.push({ type: "local", path: pluginRoot });
	}

	return plugins;
}

async function hasSkills(skillsDir: string): Promise<boolean> {
	try {
		const entries = await readdir(skillsDir, { withFileTypes: true });
		return entries.some((e) => e.isDirectory() || e.isSymbolicLink());
	} catch {
		return false;
	}
}

async function ensurePluginScaffold(
	pluginRoot: string,
	skillsSrc: string,
	siblingDisplayName: string,
): Promise<void> {
	await mkdir(join(pluginRoot, ".claude-plugin"), { recursive: true });

	const manifestPath = join(pluginRoot, ".claude-plugin", "plugin.json");
	if (!(await exists(manifestPath))) {
		await writeFile(
			manifestPath,
			`${JSON.stringify(
				{
					name: `sibling-${siblingDisplayName}`,
					description: `Skills imported from sibling worktree '${siblingDisplayName}' for cross-repo discovery`,
				},
				null,
				"\t",
			)}\n`,
		);
	}

	const skillsLink = join(pluginRoot, "skills");
	if (!(await exists(skillsLink))) {
		await symlink(skillsSrc, skillsLink, "dir");
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function sanitizePathForFsName(path: string): string {
	const base = basename(path);
	const hash = createHash("sha1").update(path).digest("hex").slice(0, 8);
	return `${base.replace(/[^a-zA-Z0-9._-]/g, "_")}-${hash}`;
}
