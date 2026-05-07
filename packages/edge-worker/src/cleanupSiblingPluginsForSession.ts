import { rm } from "node:fs/promises";
import { join } from "node:path";

export interface CleanupSiblingPluginsForSessionInput {
	cyrusHome: string;
	sessionId: string;
}

/**
 * Remove the session-scoped sibling-plugins temp directory created by
 * `resolveSiblingSkillPlugins` for the given session.
 *
 * Path: `<cyrusHome>/sibling-plugins/<sessionId>/`
 *
 * No-op if the directory does not exist (session never had sibling
 * plugins). Removes recursively (manifest, symlinks). Symlinked targets
 * outside the session dir are NOT followed — only the link inside the
 * session dir is removed.
 */
export async function cleanupSiblingPluginsForSession(
	input: CleanupSiblingPluginsForSessionInput,
): Promise<void> {
	const sessionDir = join(input.cyrusHome, "sibling-plugins", input.sessionId);
	await rm(sessionDir, { recursive: true, force: true });
}
