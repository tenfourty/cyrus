import { AgentSessionStatus } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	isTerminalSessionStatus,
	shouldPostTerminalNotice,
} from "../src/sessionStatus.js";

describe("isTerminalSessionStatus", () => {
	it("true for Complete", () => {
		expect(isTerminalSessionStatus(AgentSessionStatus.Complete)).toBe(true);
	});
	it("true for Error", () => {
		expect(isTerminalSessionStatus(AgentSessionStatus.Error)).toBe(true);
	});
	it("true for Stale", () => {
		expect(isTerminalSessionStatus(AgentSessionStatus.Stale)).toBe(true);
	});
	it("false for Active", () => {
		expect(isTerminalSessionStatus(AgentSessionStatus.Active)).toBe(false);
	});
});

describe("shouldPostTerminalNotice", () => {
	it("true for a non-terminal status on a Linear session", () => {
		expect(shouldPostTerminalNotice(AgentSessionStatus.Active, "linear")).toBe(
			true,
		);
	});
	it("false when the pre-flip status is already terminal", () => {
		expect(
			shouldPostTerminalNotice(AgentSessionStatus.Complete, "linear"),
		).toBe(false);
	});
	it("false for a non-Linear tracker", () => {
		expect(shouldPostTerminalNotice(AgentSessionStatus.Active, "gitlab")).toBe(
			false,
		);
	});
	it("false when the status is unknown (undefined)", () => {
		expect(shouldPostTerminalNotice(undefined, "linear")).toBe(false);
	});
});
