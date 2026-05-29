import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpConfigService } from "../src/McpConfigService.js";

function makeDeps() {
	const fakeClient = { client: { request: vi.fn(), setHeader: vi.fn() } };
	// Provide both dep names so this test works regardless of which Linear-token
	// dep the McpConfigService consumes: `getLinearTokenForWorkspace` on
	// upstream `origin/main`, `ensureFreshLinearToken` on `tenfourty-deploy`
	// (added by the proactive-Linear-token-refresh fix). Mirrors the pattern
	// captured in `project_edgeworker_mock_staleness.md`.
	return {
		getLinearTokenForWorkspace: vi.fn(() => "tok"),
		ensureFreshLinearToken: vi.fn(async () => "tok"),
		getIssueTracker: vi.fn(() => ({
			getClient: () => fakeClient,
		})),
		getCyrusToolsMcpUrl: () => "http://localhost:9999/mcp",
		createCyrusToolsOptions: () => ({}) as any,
	} as any;
}

/**
 * Regression guard: a floating `@latest` tag on slack-mcp-server allowed an
 * upstream release to flip the Slack MCP server from connected to failed
 * between Cyrus restarts (channel-enumeration switched from soft-warn to
 * fatal at boot when scopes are incomplete). The version is pinned to a
 * known-good release so an upstream change cannot silently break Slack
 * sessions without an explicit bump here.
 */
describe("McpConfigService Slack server pin", () => {
	const originalToken = process.env.SLACK_BOT_TOKEN;
	beforeEach(() => {
		process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
	});
	afterEach(() => {
		if (originalToken === undefined) {
			delete process.env.SLACK_BOT_TOKEN;
		} else {
			process.env.SLACK_BOT_TOKEN = originalToken;
		}
	});

	it("pins slack-mcp-server to an exact version, not a floating tag", async () => {
		const service = new McpConfigService(makeDeps());
		const config = await service.buildMcpConfig("repo-1", "workspace-1", "s-1");

		const slack = config.slack as { args?: string[] } | undefined;
		expect(slack?.args).toBeDefined();
		const packageArg = slack!.args!.find((a) =>
			a.startsWith("slack-mcp-server"),
		);
		expect(packageArg).toBeDefined();
		expect(packageArg).not.toMatch(/@latest$/);
		expect(packageArg).toMatch(/^slack-mcp-server@\d+\.\d+\.\d+$/);
	});
});
