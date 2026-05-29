import { describe, expect, it } from "vitest";
import type { ChatRepositoryProvider } from "../src/ChatRepositoryProvider.js";
import { SlackChatAdapter } from "../src/SlackChatAdapter.js";

/**
 * The Slack system prompt instructs the agent to drive Linear via
 * `mcp__linear__*` tools, but says nothing about what to do when those tools
 * are not in the agent's tool list (i.e. the Linear MCP server failed to
 * attach). Combined with the existing "you can answer questions and assist
 * with research" framing, that gap left the agent rationalizing missing
 * capabilities as intentional scope. This nudge closes the gap generically
 * for any MCP server failure, not just Linear.
 */
describe("SlackChatAdapter system prompt — MCP failure nudge", () => {
	const repoProvider: ChatRepositoryProvider = {
		getRepositoryPaths: () => [],
		getDefaultLinearWorkspaceId: () => undefined,
	} as unknown as ChatRepositoryProvider;

	const event = {
		eventId: "ev-1",
		payload: {
			text: "<@U123> hi",
			user: "U999",
			channel: "C123",
			ts: "1700000000.0",
		},
	} as any;

	it("contains the exact Tool Availability section instructing the agent to report MCP failures", () => {
		const adapter = new SlackChatAdapter(repoProvider);
		const prompt = adapter.buildSystemPrompt(event);

		const expectedBlock = `## Tool Availability
- Your available tools are the ones that actually attached for this session. If an \`mcp__<server>__*\` tool you were instructed to use below is NOT present in your tools list, the corresponding MCP server failed to attach. When that happens, report the connection failure plainly to the user — name the missing server (e.g. \`linear\`, \`slack\`, \`cyrus-tools\`) and ask them to check the Cyrus logs or their setup. Do NOT reframe missing tools as intentional scope ("scoped to research/Q&A by design" is wrong), and do NOT improvise around the gap.`;

		expect(prompt).toContain(expectedBlock);
	});
});
