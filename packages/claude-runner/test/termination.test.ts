import { describe, expect, it } from "vitest";
import { classifyRunnerTermination } from "../src/termination.js";

const abort = Object.assign(new Error("aborted by user"), {
	name: "AbortError",
});
const sigterm = new Error("Claude Code process exited with code 143");
const boom = new Error("upstream 500");

describe("classifyRunnerTermination", () => {
	it("classifies a requested abort as requested", () => {
		expect(
			classifyRunnerTermination(abort, {
				stopRequested: true,
				stalled: false,
			}),
		).toEqual({
			kind: "requested",
			reason: "user_abort",
		});
	});
	it("classifies a requested SIGTERM (code 143) as requested", () => {
		expect(
			classifyRunnerTermination(sigterm, {
				stopRequested: true,
				stalled: false,
			}),
		).toEqual({
			kind: "requested",
			reason: "sigterm",
		});
	});
	it("classifies an UNrequested, unstalled abort as crashed/abort", () => {
		expect(
			classifyRunnerTermination(abort, {
				stopRequested: false,
				stalled: false,
			}),
		).toEqual({
			kind: "crashed",
			reason: "abort",
		});
	});
	it("classifies an UNrequested, unstalled SIGTERM (code 143) as crashed/sigterm", () => {
		expect(
			classifyRunnerTermination(sigterm, {
				stopRequested: false,
				stalled: false,
			}),
		).toEqual({
			kind: "crashed",
			reason: "sigterm",
		});
	});
	it("classifies an UNrequested, stalled abort as crashed/stall", () => {
		expect(
			classifyRunnerTermination(abort, {
				stopRequested: false,
				stalled: true,
			}),
		).toEqual({
			kind: "crashed",
			reason: "stall",
		});
	});
	it("classifies an UNrequested, stalled SIGTERM (code 143) as crashed/stall", () => {
		expect(
			classifyRunnerTermination(sigterm, {
				stopRequested: false,
				stalled: true,
			}),
		).toEqual({
			kind: "crashed",
			reason: "stall",
		});
	});
	it("prefers a requested stop over a stale stalled flag (precedence)", () => {
		expect(
			classifyRunnerTermination(abort, {
				stopRequested: true,
				stalled: true,
			}),
		).toEqual({
			kind: "requested",
			reason: "user_abort",
		});
	});
	it("classifies a genuine error as error regardless of flags", () => {
		expect(
			classifyRunnerTermination(boom, {
				stopRequested: false,
				stalled: false,
			}),
		).toEqual({ kind: "error" });
		expect(
			classifyRunnerTermination(boom, {
				stopRequested: true,
				stalled: false,
			}),
		).toEqual({ kind: "error" });
		expect(
			classifyRunnerTermination(boom, {
				stopRequested: false,
				stalled: true,
			}),
		).toEqual({ kind: "error" });
		expect(
			classifyRunnerTermination(boom, {
				stopRequested: true,
				stalled: true,
			}),
		).toEqual({ kind: "error" });
	});
});
