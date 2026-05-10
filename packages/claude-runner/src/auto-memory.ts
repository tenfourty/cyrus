import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Encode an absolute filesystem path into Claude Code's auto-memory project
 * directory name: every `/` and `.` in the path becomes `-`. This matches the
 * encoding used by Claude Code itself when it materializes per-project state
 * under `~/.claude/projects/<encoded>/`. Getting the encoder wrong silently
 * fails any allow-list carve-out built from it, so keep it dead simple.
 *
 * Example: `/root/.cyrus/repos/repoA` → `-root--cyrus-repos-repoA`
 */
export function encodeClaudeProjectDirName(absolutePath: string): string {
	return absolutePath.replace(/[/.]/g, "-");
}

/**
 * Resolve the auto-memory directory Claude Code uses for the given
 * repository: `~/.claude/projects/<encoded-repo-path>/memory/`. Auto-memory
 * is anchored at the git repo root (the bare repo path stored in
 * `repository.repositoryPath`), not the worktree, so callers should pass the
 * bare repo path here — the worktree path encodes to a different project dir.
 */
export function getClaudeProjectAutoMemoryDir(repoPath: string): string {
	return join(
		homedir(),
		".claude",
		"projects",
		encodeClaudeProjectDirName(repoPath),
		"memory",
	);
}
