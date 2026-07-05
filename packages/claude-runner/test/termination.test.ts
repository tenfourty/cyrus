import { describe, expect, it } from "vitest";
import { classifyRunnerTermination } from "../src/termination.js";

const abort = Object.assign(new Error("aborted by user"), {
	name: "AbortError",
});
const sigterm = new Error("Claude Code process exited with code 143");
const boom = new Error("upstream 500");

describe("classifyRunnerTermination", () => {
	it("classifies a requested abort as requested", () => {
		expect(classifyRunnerTermination(abort, true)).toEqual({
			kind: "requested",
			reason: "user_abort",
		});
	});
	it("classifies an UNrequested abort as crashed", () => {
		expect(classifyRunnerTermination(abort, false)).toEqual({
			kind: "crashed",
			reason: "abort",
		});
	});
	it("classifies a requested SIGTERM (code 143) as requested", () => {
		expect(classifyRunnerTermination(sigterm, true)).toEqual({
			kind: "requested",
			reason: "sigterm",
		});
	});
	it("classifies an UNrequested SIGTERM (code 143) as crashed", () => {
		expect(classifyRunnerTermination(sigterm, false)).toEqual({
			kind: "crashed",
			reason: "sigterm",
		});
	});
	it("classifies a genuine error as error regardless of stopRequested", () => {
		expect(classifyRunnerTermination(boom, false)).toEqual({ kind: "error" });
		expect(classifyRunnerTermination(boom, true)).toEqual({ kind: "error" });
	});
});
