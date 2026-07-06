import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StallWatchdog } from "../src/stallWatchdog.js";

const assistantToolUse = {
	type: "assistant",
	message: { content: [{ type: "tool_use", name: "Bash", input: {} }] },
};
const userToolResult = {
	type: "user",
	message: {
		content: [{ type: "tool_result", tool_use_id: "abc", content: "ok" }],
	},
};
const assistantText = {
	type: "assistant",
	message: { content: [{ type: "text", text: "thinking..." }] },
};
const resultMessage = { type: "result", subtype: "success" };

describe("StallWatchdog", () => {
	const cfg = { enabled: true, idleMs: 600_000, toolMs: 1_800_000 };

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("fires onStall after idleMs of silence following beginTurn", () => {
		const onStall = vi.fn();
		const watchdog = new StallWatchdog(cfg, onStall);

		watchdog.beginTurn();
		vi.advanceTimersByTime(cfg.idleMs);

		expect(onStall).toHaveBeenCalledTimes(1);
	});

	it("does not fire before idleMs elapses", () => {
		const onStall = vi.fn();
		const watchdog = new StallWatchdog(cfg, onStall);

		watchdog.beginTurn();
		vi.advanceTimersByTime(cfg.idleMs - 1);

		expect(onStall).not.toHaveBeenCalled();
	});

	it("a non-result onMessage resets the idle timer", () => {
		const onStall = vi.fn();
		const watchdog = new StallWatchdog(cfg, onStall);

		watchdog.beginTurn();
		// Advance partway, then a message resets the clock.
		vi.advanceTimersByTime(cfg.idleMs - 1000);
		watchdog.onMessage(assistantText);
		// Advancing the remainder of the ORIGINAL budget must NOT fire, since
		// the timer was reset by the message above.
		vi.advanceTimersByTime(999);
		expect(onStall).not.toHaveBeenCalled();

		// But advancing a full idleMs from the reset point does fire.
		vi.advanceTimersByTime(cfg.idleMs - 999);
		expect(onStall).toHaveBeenCalledTimes(1);
	});

	it("partial advance, then message, then partial advance never fires", () => {
		const onStall = vi.fn();
		const watchdog = new StallWatchdog(cfg, onStall);

		watchdog.beginTurn();
		vi.advanceTimersByTime(cfg.idleMs / 2);
		watchdog.onMessage(assistantText);
		vi.advanceTimersByTime(cfg.idleMs / 2);

		expect(onStall).not.toHaveBeenCalled();
	});

	it("gives a tool-in-flight turn the longer tool budget, not the idle budget", () => {
		const onStall = vi.fn();
		const watchdog = new StallWatchdog(cfg, onStall);

		watchdog.beginTurn();
		watchdog.onMessage(assistantToolUse); // pendingToolCount -> 1, re-arms with toolMs

		// Past idleMs but before toolMs: must NOT fire.
		vi.advanceTimersByTime(cfg.idleMs + 1);
		expect(onStall).not.toHaveBeenCalled();

		// Past toolMs: fires.
		vi.advanceTimersByTime(cfg.toolMs - cfg.idleMs);
		expect(onStall).toHaveBeenCalledTimes(1);
	});

	it("a following tool_result drops the count back to the idle budget", () => {
		const onStall = vi.fn();
		const watchdog = new StallWatchdog(cfg, onStall);

		watchdog.beginTurn();
		watchdog.onMessage(assistantToolUse); // pendingToolCount -> 1 (tool budget)
		watchdog.onMessage(userToolResult); // pendingToolCount -> 0 (back to idle budget)

		vi.advanceTimersByTime(cfg.idleMs);
		expect(onStall).toHaveBeenCalledTimes(1);
	});

	it("load-bearing: a result message disarms the turn and a stray later message does not re-arm", () => {
		const onStall = vi.fn();
		const watchdog = new StallWatchdog(cfg, onStall);

		watchdog.beginTurn();
		watchdog.onMessage(resultMessage); // ends the turn

		// Advancing past any budget after the turn ended must NOT fire — this
		// covers a warm runner idling between turns for an unbounded time.
		vi.advanceTimersByTime(cfg.toolMs * 10);
		expect(onStall).not.toHaveBeenCalled();

		// A stray non-result message after the turn ended (turnActive false)
		// must be a no-op — it must NOT re-arm the watchdog.
		watchdog.onMessage(assistantText);
		vi.advanceTimersByTime(cfg.toolMs * 10);
		expect(onStall).not.toHaveBeenCalled();
	});

	it("never fires when cfg.enabled is false, even across beginTurn/onMessage", () => {
		const onStall = vi.fn();
		const watchdog = new StallWatchdog({ ...cfg, enabled: false }, onStall);

		watchdog.beginTurn();
		watchdog.onMessage(assistantToolUse);
		vi.advanceTimersByTime(cfg.toolMs * 10);

		expect(onStall).not.toHaveBeenCalled();
	});

	it("endTurn disarms — no fire afterward", () => {
		const onStall = vi.fn();
		const watchdog = new StallWatchdog(cfg, onStall);

		watchdog.beginTurn();
		vi.advanceTimersByTime(cfg.idleMs / 2);
		watchdog.endTurn();
		vi.advanceTimersByTime(cfg.idleMs * 10);

		expect(onStall).not.toHaveBeenCalled();
	});

	it("dispose disarms — no fire afterward", () => {
		const onStall = vi.fn();
		const watchdog = new StallWatchdog(cfg, onStall);

		watchdog.beginTurn();
		vi.advanceTimersByTime(cfg.idleMs / 2);
		watchdog.dispose();
		vi.advanceTimersByTime(cfg.idleMs * 10);

		expect(onStall).not.toHaveBeenCalled();
	});

	it("fires onStall at most once per armed period (does not keep firing)", () => {
		const onStall = vi.fn();
		const watchdog = new StallWatchdog(cfg, onStall);

		watchdog.beginTurn();
		vi.advanceTimersByTime(cfg.idleMs);
		vi.advanceTimersByTime(cfg.idleMs * 5);

		expect(onStall).toHaveBeenCalledTimes(1);
	});

	it("a fresh beginTurn after a prior turn ended re-arms for the new turn", () => {
		const onStall = vi.fn();
		const watchdog = new StallWatchdog(cfg, onStall);

		watchdog.beginTurn();
		watchdog.onMessage(resultMessage); // turn 1 ends

		watchdog.beginTurn(); // turn 2 (warm follow-up)
		vi.advanceTimersByTime(cfg.idleMs);

		expect(onStall).toHaveBeenCalledTimes(1);
	});
});
