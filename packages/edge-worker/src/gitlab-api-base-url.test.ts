import { describe, expect, it } from "vitest";
import { deriveGitlabApiBaseUrl } from "./gitlab-api-base-url";

describe("deriveGitlabApiBaseUrl", () => {
	it("returns the origin from the first repo with a gitlabUrl", () => {
		expect(
			deriveGitlabApiBaseUrl([
				{ id: "a", gitlabUrl: "https://gitlab.example.com/group/proj" },
			]),
		).toBe("https://gitlab.example.com");
	});

	it("returns gitlab.com origin when gitlab.com is configured", () => {
		expect(
			deriveGitlabApiBaseUrl([
				{ id: "a", gitlabUrl: "https://gitlab.com/group/proj" },
			]),
		).toBe("https://gitlab.com");
	});

	it("skips repos without gitlabUrl until it finds the first match", () => {
		expect(
			deriveGitlabApiBaseUrl([
				{ id: "a" },
				{ id: "b", githubUrl: "https://github.com/x/y" },
				{ id: "c", gitlabUrl: "https://gitlab.self.host/g/p" },
			]),
		).toBe("https://gitlab.self.host");
	});

	it("returns undefined when no repo has a gitlabUrl", () => {
		expect(
			deriveGitlabApiBaseUrl([
				{ id: "a" },
				{ id: "b", githubUrl: "https://github.com/x/y" },
			]),
		).toBeUndefined();
	});

	it("returns undefined when gitlabUrl is malformed", () => {
		expect(
			deriveGitlabApiBaseUrl([{ id: "a", gitlabUrl: "not a url" }]),
		).toBeUndefined();
	});

	it("returns undefined for empty repository list", () => {
		expect(deriveGitlabApiBaseUrl([])).toBeUndefined();
	});
});
