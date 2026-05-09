import type { CyrusAgentSession, RepositoryConfig } from "cyrus-core";
import { formatBaseBranchUpdate } from "./baseBranchUpdate.js";

interface DriftCheckCapableGitService {
	checkBaseBranchDrift(
		worktreePath: string,
		baseBranch: string,
	): Promise<{ commitCount: number; branchName: string } | null>;
}

interface ComputeBlocksInput {
	session: CyrusAgentSession;
	primaryRepo: RepositoryConfig;
	resolveRepo: (repoId: string) => RepositoryConfig | undefined;
	gitService: DriftCheckCapableGitService;
}

/**
 * Build zero-or-more `<base_branch_update>` blocks describing base-branch
 * drift detected at session resume time, one per participating repository.
 *
 * For single-repo sessions, the primary worktree is checked. For multi-repo
 * sessions, every entry in `session.workspace.repoPaths` is checked
 * independently. Each repo resolves its base branch via the persisted
 * `resolvedBaseBranches` (set at worktree creation), falling back to the
 * repository's configured `baseBranch`.
 *
 * Drift detection is best-effort: any individual git failure produces no
 * block for that repo and is logged at the GitService layer; the resume
 * itself never blocks on drift detection.
 */
export async function computeResumeBaseBranchDriftBlocks(
	input: ComputeBlocksInput,
): Promise<string[]> {
	const { session, primaryRepo, resolveRepo, gitService } = input;
	const targets = collectDriftTargets(session, primaryRepo, resolveRepo);

	const blocks: string[] = [];
	for (const target of targets) {
		try {
			const drift = await gitService.checkBaseBranchDrift(
				target.worktreePath,
				target.baseBranch,
			);
			if (!drift) continue;
			blocks.push(
				formatBaseBranchUpdate({
					branchName: drift.branchName,
					repository: target.displayName,
					commitCount: drift.commitCount,
				}),
			);
		} catch {
			// Best-effort — never block resume on drift detection.
		}
	}
	return blocks;
}

interface DriftTarget {
	worktreePath: string;
	baseBranch: string;
	displayName: string;
}

function collectDriftTargets(
	session: CyrusAgentSession,
	primaryRepo: RepositoryConfig,
	resolveRepo: (repoId: string) => RepositoryConfig | undefined,
): DriftTarget[] {
	const repoPaths = session.workspace.repoPaths;
	if (repoPaths && Object.keys(repoPaths).length > 0) {
		const targets: DriftTarget[] = [];
		for (const [repoId, worktreePath] of Object.entries(repoPaths)) {
			const repo = resolveRepo(repoId);
			if (!repo) continue;
			targets.push({
				worktreePath,
				baseBranch: resolveBaseBranch(session, repoId, repo),
				displayName: repo.name,
			});
		}
		return targets;
	}
	return [
		{
			worktreePath: session.workspace.path,
			baseBranch: resolveBaseBranch(session, primaryRepo.id, primaryRepo),
			displayName: primaryRepo.name,
		},
	];
}

function resolveBaseBranch(
	session: CyrusAgentSession,
	repoId: string,
	repo: RepositoryConfig,
): string {
	return (
		session.workspace.resolvedBaseBranches?.[repoId]?.branch ?? repo.baseBranch
	);
}
