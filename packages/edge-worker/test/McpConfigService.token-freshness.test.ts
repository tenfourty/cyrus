import { describe, expect, it, vi } from "vitest";
import { McpConfigService } from "../src/McpConfigService.js";

/**
 * Seam test: the Linear MCP server is handed a static bearer token at
 * session-build time and cannot self-refresh. buildMcpConfig must therefore
 * source that token through the proactive-freshness path (ensureFreshLinearToken),
 * NOT a verbatim stored value that may have aged out.
 */
function makeDeps(overrides: Record<string, unknown> = {}) {
	const fakeClient = { client: { request: vi.fn(), setHeader: vi.fn() } };
	return {
		ensureFreshLinearToken: vi.fn(async () => "fresh_token"),
		getIssueTracker: vi.fn(() => ({
			getClient: () => fakeClient,
		})),
		getCyrusToolsMcpUrl: () => "http://localhost:9999/mcp",
		createCyrusToolsOptions: () => ({}) as any,
		...overrides,
	} as any;
}

describe("McpConfigService Linear token freshness", () => {
	it("puts the proactively-refreshed token in the Linear MCP Authorization header", async () => {
		const deps = makeDeps();
		const service = new McpConfigService(deps);

		const config = await service.buildMcpConfig(
			"repo-1",
			"workspace-1",
			"sess-1",
		);

		expect(deps.ensureFreshLinearToken).toHaveBeenCalledWith("workspace-1");
		expect((config.linear as any).headers.Authorization).toBe(
			"Bearer fresh_token",
		);
	});

	it("falls back to a Linear-less config when no token can be obtained", async () => {
		const deps = makeDeps({
			ensureFreshLinearToken: vi.fn(async () => null),
		});
		const service = new McpConfigService(deps);

		const config = await service.buildMcpConfig(
			"repo-1",
			"workspace-1",
			"sess-1",
		);

		expect(config.linear).toBeUndefined();
		expect(config["cyrus-docs"]).toBeDefined();
	});
});
