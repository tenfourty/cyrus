/**
 * Format the `<base_branch_update>` block sent to the agent when origin
 * of the configured base branch has moved.
 *
 * Both the live GitHub-push path (rich payload: compare URL, commit list)
 * and the resume-time drift-check path (minimal payload: branch + count)
 * use this helper so the agent sees the same XML shape regardless of
 * trigger.
 */
export interface BaseBranchUpdateInput {
	branchName: string;
	repository: string;
	commitCount: number;
	compareUrl?: string;
	commits?: string[];
}

const COMMIT_PREVIEW_LIMIT = 5;

export function formatBaseBranchUpdate(input: BaseBranchUpdateInput): string {
	const { branchName, repository, commitCount, compareUrl, commits } = input;
	const lines: string[] = [
		"<base_branch_update>",
		`<branch>${branchName}</branch>`,
		`<repository>${repository}</repository>`,
		`<commit_count>${commitCount}</commit_count>`,
	];

	if (compareUrl) {
		lines.push(`<compare_url>${compareUrl}</compare_url>`);
	}

	if (commits && commits.length > 0) {
		const previewed = commits.slice(0, COMMIT_PREVIEW_LIMIT);
		const previewLines = previewed.map((c) => `- ${c.split("\n")[0]}`);
		const remainder = commits.length - previewed.length;
		const moreLine = remainder > 0 ? `\n- ... and ${remainder} more` : "";
		lines.push(`<commits>\n${previewLines.join("\n")}${moreLine}\n</commits>`);
	}

	const guidance = compareUrl
		? `Your base branch \`${branchName}\` has received ${commitCount} new commit(s). Consider rebasing your working branch onto the updated base to avoid merge conflicts. You can do this with: \`git fetch origin && git rebase origin/${branchName}\``
		: `Your base branch \`${branchName}\` has received ${commitCount} new commit(s) while this session was dormant. Consider rebasing your working branch onto the updated base to avoid merge conflicts. You can do this with: \`git fetch origin && git rebase origin/${branchName}\``;

	lines.push(`<guidance>\n${guidance}\n</guidance>`);
	lines.push("</base_branch_update>");

	return lines.join("\n");
}
