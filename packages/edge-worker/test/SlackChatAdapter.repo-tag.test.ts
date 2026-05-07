/**
 * Tests for SlackChatAdapter's first-message repo-tag handling.
 *
 * Users can prefix a Slack mention with `[repos=repo-a,repo-b]` (or
 * unbracketed `repos=repo-a,repo-b`) to narrow the repository set the
 * agent operates on for this thread. The adapter must:
 *   1. Strip the tag from `extractTaskInstructions(event)` output
 *   2. Filter the Repository Access list in `buildSystemPrompt(event)`
 *      to only the named repos (when at least one name matches a
 *      configured repo path)
 *
 * When no tag is present, behavior is unchanged from prior (all
 * configured paths shown, full text returned).
 */

import type { SlackWebhookEvent } from "cyrus-slack-event-transport";
import { describe, expect, it } from "vitest";
import type { ChatRepositoryProvider } from "../src/ChatRepositoryProvider.js";
import { SlackChatAdapter } from "../src/SlackChatAdapter.js";

function buildProvider(paths: string[]): ChatRepositoryProvider {
	return {
		getRepositoryPaths: () => paths,
		getDefaultLinearWorkspaceId: () => "ws-1",
		getDefaultRepository: () => undefined,
	} as unknown as ChatRepositoryProvider;
}

function buildEvent(text: string): SlackWebhookEvent {
	return {
		eventId: "evt-1",
		payload: {
			user: "U123",
			channel: "C456",
			text,
			ts: "1700000000.000100",
		},
	} as unknown as SlackWebhookEvent;
}

describe("SlackChatAdapter — first-message repo tag", () => {
	const allPaths = ["/repos/repo-a", "/repos/repo-b", "/repos/repo-deploy"];

	it("extractTaskInstructions strips a leading [repos=...] tag", () => {
		const adapter = new SlackChatAdapter(buildProvider(allPaths));
		const event = buildEvent("[repos=repo-a,repo-b] update the runbook please");
		expect(adapter.extractTaskInstructions(event)).toBe(
			"update the runbook please",
		);
	});

	it("extractTaskInstructions returns the full text when no tag present", () => {
		const adapter = new SlackChatAdapter(buildProvider(allPaths));
		const event = buildEvent("just do the thing");
		expect(adapter.extractTaskInstructions(event)).toBe("just do the thing");
	});

	it("buildSystemPrompt filters Repository Access to tagged repos only", () => {
		const adapter = new SlackChatAdapter(buildProvider(allPaths));
		const event = buildEvent("[repos=repo-a,repo-b] do the thing");
		const prompt = adapter.buildSystemPrompt(event);
		// Tagged repos must appear
		expect(prompt).toContain("/repos/repo-a");
		expect(prompt).toContain("/repos/repo-b");
		// Untagged repo must NOT appear (basename match — full path filtered out)
		expect(prompt).not.toContain("/repos/repo-deploy");
	});

	it("buildSystemPrompt shows all configured paths when no tag is present", () => {
		const adapter = new SlackChatAdapter(buildProvider(allPaths));
		const event = buildEvent("just answer this question");
		const prompt = adapter.buildSystemPrompt(event);
		expect(prompt).toContain("/repos/repo-a");
		expect(prompt).toContain("/repos/repo-b");
		expect(prompt).toContain("/repos/repo-deploy");
	});

	it("buildSystemPrompt shows all paths when tag references unknown repo names", () => {
		const adapter = new SlackChatAdapter(buildProvider(allPaths));
		const event = buildEvent("[repos=ghost-repo] do the thing");
		const prompt = adapter.buildSystemPrompt(event);
		// No matching repos → fall back to showing all (so chat still works)
		expect(prompt).toContain("/repos/repo-a");
		expect(prompt).toContain("/repos/repo-b");
		expect(prompt).toContain("/repos/repo-deploy");
	});

	it("buildSystemPrompt matches repo by basename of the path", () => {
		const adapter = new SlackChatAdapter(buildProvider(allPaths));
		const event = buildEvent("[repo=repo-b] just this one");
		const prompt = adapter.buildSystemPrompt(event);
		expect(prompt).toContain("/repos/repo-b");
		expect(prompt).not.toContain("/repos/repo-deploy");
		// Ensure matching is exact-basename, not fuzzy/partial — `/repos/repo-a`
		// should NOT appear because the user explicitly tagged only `repo-b`.
		// The basename of `/repos/repo-a` is `repo-a`, not `repo-b`.
		expect(prompt.includes("/repos/repo-a\n")).toBe(false);
		expect(prompt.includes("/repos/repo-a ")).toBe(false);
	});
});
