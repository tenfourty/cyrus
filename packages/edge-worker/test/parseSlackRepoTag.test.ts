/**
 * Tests for parseSlackRepoTag.
 *
 * Slack chat sessions have access to ALL configured repos by default.
 * Users can narrow the active set for a session by prefixing their
 * mention with `[repos=cove,cove-ovh]` or `repos=cove,cove-ovh`. The
 * tag is parsed out before the message is shown to the agent so it
 * doesn't pollute the task instructions.
 */

import { describe, expect, it } from "vitest";
import { parseSlackRepoTag } from "../src/parseSlackRepoTag.js";

describe("parseSlackRepoTag", () => {
	it("returns empty repoNames and full text when no tag present", () => {
		const result = parseSlackRepoTag("just do the thing please");
		expect(result.repoNames).toEqual([]);
		expect(result.cleanText).toBe("just do the thing please");
	});

	it("parses [repos=a,b] bracketed tag and strips it from the text", () => {
		const result = parseSlackRepoTag(
			"[repos=cove,cove-ovh] update the runbook",
		);
		expect(result.repoNames).toEqual(["cove", "cove-ovh"]);
		expect(result.cleanText).toBe("update the runbook");
	});

	it("parses [repo=name] singular bracketed tag (single repo)", () => {
		const result = parseSlackRepoTag("[repo=cove] only this one");
		expect(result.repoNames).toEqual(["cove"]);
		expect(result.cleanText).toBe("only this one");
	});

	it("parses unbracketed `repos=a,b` at start of message", () => {
		const result = parseSlackRepoTag("repos=cove,cove-ovh edit the deploy");
		expect(result.repoNames).toEqual(["cove", "cove-ovh"]);
		expect(result.cleanText).toBe("edit the deploy");
	});

	it("parses unbracketed `repo=name` at start of message", () => {
		const result = parseSlackRepoTag("repo=cove tweak the schema");
		expect(result.repoNames).toEqual(["cove"]);
		expect(result.cleanText).toBe("tweak the schema");
	});

	it("only strips the tag when it appears at the START of the message", () => {
		// Tag in the middle is ignored — keeps the text intact, no filter
		const result = parseSlackRepoTag(
			"please look at [repos=cove] later in the message",
		);
		expect(result.repoNames).toEqual([]);
		expect(result.cleanText).toBe(
			"please look at [repos=cove] later in the message",
		);
	});

	it("trims leading whitespace before the tag and after stripping", () => {
		const result = parseSlackRepoTag(
			"   [repos=cove,cove-ovh]   do the thing   ",
		);
		expect(result.repoNames).toEqual(["cove", "cove-ovh"]);
		expect(result.cleanText).toBe("do the thing");
	});

	it("returns deduplicated repoNames preserving first-occurrence order", () => {
		const result = parseSlackRepoTag("[repos=cove,cove-ovh,cove] do the thing");
		expect(result.repoNames).toEqual(["cove", "cove-ovh"]);
		expect(result.cleanText).toBe("do the thing");
	});

	it("returns empty cleanText when message is only the tag", () => {
		const result = parseSlackRepoTag("[repos=cove,cove-ovh]");
		expect(result.repoNames).toEqual(["cove", "cove-ovh"]);
		expect(result.cleanText).toBe("");
	});

	it("ignores tags that are part of a URL", () => {
		const result = parseSlackRepoTag(
			"check https://example.com/repos=hi for more info",
		);
		expect(result.repoNames).toEqual([]);
		expect(result.cleanText).toBe(
			"check https://example.com/repos=hi for more info",
		);
	});
});
