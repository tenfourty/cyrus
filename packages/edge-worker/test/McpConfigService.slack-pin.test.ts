import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpConfigService } from "../src/McpConfigService.js";

function makeDeps() {
	const fakeClient = { client: { request: vi.fn(), setHeader: vi.fn() } };
	return {
		getLinearTokenForWorkspace: vi.fn(() => "tok"),
		getIssueTracker: vi.fn(() => ({
			getClient: () => fakeClient,
		})),
		getCyrusToolsMcpUrl: () => "http://localhost:9999/mcp",
		createCyrusToolsOptions: () => ({}) as any,
	} as any;
}

/**
 * Regression guard: verifies slack-mcp-server is pinned to an exact semver,
 * not a floating tag.
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
		expect(packageArg).toMatch(/^slack-mcp-server@\d+\.\d+\.\d+$/);
	});
});
