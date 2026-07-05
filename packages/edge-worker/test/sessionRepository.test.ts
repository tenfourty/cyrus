import type { RepositoryConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { resolveSessionRepository } from "../src/sessionRepository.js";

const repoA = { id: "repo-a", name: "A" } as unknown as RepositoryConfig;

describe("resolveSessionRepository", () => {
	it("resolves the repo for a session", () => {
		const deps = {
			sessionRepositories: new Map([["s1", "repo-a"]]),
			repositories: new Map([["repo-a", repoA]]),
		};
		expect(resolveSessionRepository("s1", deps)).toBe(repoA);
	});
	it("returns undefined when the session has no mapped repo", () => {
		const deps = {
			sessionRepositories: new Map(),
			repositories: new Map([["repo-a", repoA]]),
		};
		expect(resolveSessionRepository("s1", deps)).toBeUndefined();
	});
	it("returns undefined when the repo id is unknown", () => {
		const deps = {
			sessionRepositories: new Map([["s1", "gone"]]),
			repositories: new Map([["repo-a", repoA]]),
		};
		expect(resolveSessionRepository("s1", deps)).toBeUndefined();
	});
});
