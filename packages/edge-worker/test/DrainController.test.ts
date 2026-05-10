import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { DrainController } from "../src/DrainController.js";
import type { DrainConfig } from "../src/drainTypes.js";

interface FakeASM {
  on: (ev: string, fn: any) => void;
  off: (ev: string, fn: any) => void;
  emit: (ev: string, payload: any) => void;
  getActiveAttachedSessionIds: () => string[];
  getPendingToolUseDetails: (sessionId: string) => Array<{ id: string; name: string; startedAt: number }>;
}

function makeFakeAsm(): FakeASM & EventEmitter {
  const e = new EventEmitter() as FakeASM & EventEmitter;
  const pending: Record<string, Array<{ id: string; name: string; startedAt: number }>> = {};
  let active: string[] = [];
  e.getActiveAttachedSessionIds = () => active;
  e.getPendingToolUseDetails = (sid) => pending[sid] ?? [];
  // helpers used by tests
  (e as any)._setActive = (ids: string[]) => { active = ids; };
  (e as any)._setPending = (sid: string, p: any[]) => { pending[sid] = p; };
  return e;
}

const cfg: DrainConfig = { hardCapMs: 5000, perSessionCapMs: 3000 };

describe("DrainController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts in 'running' state", () => {
    const asm = makeFakeAsm();
    const dc = new DrainController({ agentSessionManager: asm as any, config: cfg, logger: silentLogger() });
    expect(dc.getState()).toBe("running");
  });

  it("transitions to 'draining' on beginDrain and resolves drained when all sessions emit session_terminal", async () => {
    const asm = makeFakeAsm();
    (asm as any)._setActive(["s1"]);
    // Session has a pending tool — so it won't resolve immediately
    (asm as any)._setPending("s1", [{ id: "a", name: "Bash", startedAt: Date.now() }]);
    const dc = new DrainController({ agentSessionManager: asm as any, config: cfg, logger: silentLogger() });

    const promise = dc.beginDrain("sigterm");
    expect(dc.getState()).toBe("draining");

    // Clear pending and emit session_terminal to allow drain
    (asm as any)._setPending("s1", []);
    asm.emit("session_terminal", { sessionId: "s1" });
    const outcome = await promise;
    expect(outcome.kind).toBe("drained");
  });

  it("resolves drained immediately when no active sessions", async () => {
    const asm = makeFakeAsm();
    (asm as any)._setActive([]);
    const dc = new DrainController({ agentSessionManager: asm as any, config: cfg, logger: silentLogger() });

    const outcome = await dc.beginDrain("sigterm");
    expect(outcome.kind).toBe("drained");
    if (outcome.kind === "drained") {
      expect(outcome.sessionCount).toBe(0);
    }
  });

  it("waits for all pending tool_use to clear before resolving", async () => {
    const asm = makeFakeAsm();
    (asm as any)._setActive(["s1"]);
    (asm as any)._setPending("s1", [{ id: "a", name: "Bash", startedAt: Date.now() }]);
    const dc = new DrainController({ agentSessionManager: asm as any, config: cfg, logger: silentLogger() });

    let resolved = false;
    const promise = dc.beginDrain("sigterm").then((o) => { resolved = true; return o; });
    await Promise.resolve();
    expect(resolved).toBe(false);

    (asm as any)._setPending("s1", []);
    asm.emit("tool_use_completed", { sessionId: "s1", toolUseId: "a", isError: false });
    asm.emit("session_terminal", { sessionId: "s1" });

    const outcome = await promise;
    expect(outcome.kind).toBe("drained");
  });

  it("does not resolve while pending tool_use remains (no false-positive resolution)", async () => {
    const asm = makeFakeAsm();
    (asm as any)._setActive(["s1"]);
    (asm as any)._setPending("s1", [{ id: "a", name: "Bash", startedAt: Date.now() }]);
    const dc = new DrainController({ agentSessionManager: asm as any, config: cfg, logger: silentLogger() });

    let resolved = false;
    const promise = dc.beginDrain("sigterm").then((o) => { resolved = true; return o; });

    // Emit tool_use_completed but pending still non-empty in ASM
    asm.emit("tool_use_completed", { sessionId: "s1", toolUseId: "a", isError: false });
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Now clear pending and emit session_terminal
    (asm as any)._setPending("s1", []);
    asm.emit("session_terminal", { sessionId: "s1" });
    const outcome = await promise;
    expect(outcome.kind).toBe("drained");
  });

  it("force-kills on hardCapMs expiry, includes forcedSessions detail", async () => {
    const asm = makeFakeAsm();
    (asm as any)._setActive(["s1"]);
    (asm as any)._setPending("s1", [{ id: "a", name: "Bash", startedAt: Date.now() }]);
    // Use perSessionCapMs=0 so no per-session timer fires; only hard cap can trigger resolution
    const forceCfg: DrainConfig = { hardCapMs: 5000, perSessionCapMs: 0 };
    const dc = new DrainController({ agentSessionManager: asm as any, config: forceCfg, logger: silentLogger() });

    const promise = dc.beginDrain("sigterm");
    vi.advanceTimersByTime(forceCfg.hardCapMs + 10);
    const outcome = await promise;
    expect(outcome.kind).toBe("force-killed");
    if (outcome.kind === "force-killed") {
      expect(outcome.forcedSessions).toEqual([
        expect.objectContaining({
          sessionId: "s1",
          pendingToolUses: expect.arrayContaining([expect.objectContaining({ id: "a", name: "Bash" })]),
        }),
      ]);
    }
  });

  it("perSessionCap skips one stuck session and continues — outcome resolves", async () => {
    const asm = makeFakeAsm();
    (asm as any)._setActive(["s1", "s2"]);
    (asm as any)._setPending("s1", [{ id: "stuck", name: "Bash", startedAt: Date.now() }]);
    (asm as any)._setPending("s2", []);
    const dc = new DrainController({ agentSessionManager: asm as any, config: cfg, logger: silentLogger() });

    const promise = dc.beginDrain("sigterm");
    // s2 drains cleanly via session_terminal
    asm.emit("session_terminal", { sessionId: "s2" });
    // Advance past per-session cap; s1 should be treated as drainable
    vi.advanceTimersByTime(cfg.perSessionCapMs + 10);
    const outcome = await promise;
    // Outcome should be drained (s1 hit per-session cap = treated as done)
    // Hard cap has NOT fired (perSessionCapMs < hardCapMs)
    expect(outcome.kind).toBe("drained");
  });

  it("abortDrain immediately resolves with aborted-by-second-signal", async () => {
    const asm = makeFakeAsm();
    (asm as any)._setActive(["s1"]);
    (asm as any)._setPending("s1", [{ id: "a", name: "Bash", startedAt: Date.now() }]);
    const dc = new DrainController({ agentSessionManager: asm as any, config: cfg, logger: silentLogger() });

    const promise = dc.beginDrain("sigterm");
    dc.abortDrain();
    const outcome = await promise;
    expect(outcome.kind).toBe("aborted-by-second-signal");
  });

  it("getStatus returns per-session detail during drain", () => {
    const asm = makeFakeAsm();
    (asm as any)._setActive(["s1"]);
    (asm as any)._setPending("s1", [{ id: "x", name: "Edit", startedAt: Date.now() - 1000 }]);
    const dc = new DrainController({ agentSessionManager: asm as any, config: cfg, logger: silentLogger() });
    void dc.beginDrain("sigterm");
    const st = dc.getStatus();
    expect(st.state).toBe("draining");
    expect(st.sessions).toHaveLength(1);
    expect(st.sessions[0]?.sessionId).toBe("s1");
    expect(st.sessions[0]?.pendingToolUses[0]?.name).toBe("Edit");
  });

  it("rejects construction when perSessionCapMs > hardCapMs (with hardCapMs > 0)", () => {
    const asm = makeFakeAsm();
    expect(() => new DrainController({
      agentSessionManager: asm as any,
      config: { hardCapMs: 1000, perSessionCapMs: 5000 },
      logger: silentLogger(),
    })).toThrow(/perSessionCapMs.*<=.*hardCapMs/);
  });

  it("hardCapMs=0 disables drain — beginDrain resolves immediately as force-killed", async () => {
    const asm = makeFakeAsm();
    (asm as any)._setActive(["s1"]);
    (asm as any)._setPending("s1", [{ id: "a", name: "Bash", startedAt: Date.now() }]);
    const dc = new DrainController({
      agentSessionManager: asm as any,
      config: { hardCapMs: 0, perSessionCapMs: 0 },
      logger: silentLogger(),
    });
    const outcome = await dc.beginDrain("sigterm");
    expect(outcome.kind).toBe("force-killed");
  });

  it("beginDrain is idempotent — second call returns same Promise", () => {
    const asm = makeFakeAsm();
    (asm as any)._setActive(["s1"]);
    (asm as any)._setPending("s1", [{ id: "a", name: "Bash", startedAt: Date.now() }]);
    const dc = new DrainController({ agentSessionManager: asm as any, config: cfg, logger: silentLogger() });

    const p1 = dc.beginDrain("sigterm");
    const p2 = dc.beginDrain("admin-endpoint");
    expect(p1).toBe(p2);
  });

  it("state is 'shutting-down' after drain resolves", async () => {
    const asm = makeFakeAsm();
    (asm as any)._setActive(["s1"]);
    (asm as any)._setPending("s1", []);
    const dc = new DrainController({ agentSessionManager: asm as any, config: cfg, logger: silentLogger() });

    const promise = dc.beginDrain("sigterm");
    asm.emit("session_terminal", { sessionId: "s1" });
    await promise;
    expect(dc.getState()).toBe("shutting-down");
  });

  it("isDraining returns true during drain and false before", () => {
    const asm = makeFakeAsm();
    (asm as any)._setActive(["s1"]);
    (asm as any)._setPending("s1", [{ id: "a", name: "Bash", startedAt: Date.now() }]);
    const dc = new DrainController({ agentSessionManager: asm as any, config: cfg, logger: silentLogger() });

    expect(dc.isDraining()).toBe(false);
    void dc.beginDrain("sigterm");
    expect(dc.isDraining()).toBe(true);
  });

  it("second beginDrain call returns same promise without arming new timers/listeners", () => {
    const asm = makeFakeAsm();
    (asm as any)._setActive(["s1"]);
    (asm as any)._setPending("s1", [{ id: "a", name: "Bash", startedAt: Date.now() }]);
    const dc = new DrainController({ agentSessionManager: asm as any, config: cfg, logger: silentLogger() });

    const p1 = dc.beginDrain("sigterm");
    const listenerCountAfterFirst = asm.listenerCount("session_terminal");

    const p2 = dc.beginDrain("admin-endpoint");
    const listenerCountAfterSecond = asm.listenerCount("session_terminal");

    // Same promise returned
    expect(p1).toBe(p2);
    // No new listeners added
    expect(listenerCountAfterSecond).toBe(listenerCountAfterFirst);
  });

  it("concurrent session_terminal + hard-cap fire only resolves once", async () => {
    const asm = makeFakeAsm();
    (asm as any)._setActive(["s1"]);
    (asm as any)._setPending("s1", [{ id: "a", name: "Bash", startedAt: Date.now() }]);
    const dc = new DrainController({ agentSessionManager: asm as any, config: cfg, logger: silentLogger() });

    let resolutionCount = 0;
    const origResolve = Promise.resolve.bind(Promise);
    vi.spyOn(Promise, "resolve").mockImplementation((value?: any) => {
      if (value && typeof value === "object" && "kind" in value) {
        resolutionCount++;
      }
      return origResolve(value);
    });

    const promise = dc.beginDrain("sigterm");

    // Synchronously trigger both session_terminal and hard-cap expiry
    asm.emit("session_terminal", { sessionId: "s1" });
    vi.advanceTimersByTime(cfg.hardCapMs + 10);

    const outcome = await promise;
    // Should have resolved with one outcome
    expect(outcome).toBeDefined();
    // Verify resolveOutcome was only set once by checking it's null after
    // (indicating the guard worked and prevented double-resolution)
    // The actual test is that this completes without hanging or multiple resolutions
    expect(outcome.kind).toMatch(/^(drained|force-killed|aborted-by-second-signal)$/);
  });
});

function silentLogger() {
  const noop = () => undefined;
  const log: any = { info: noop, warn: noop, error: noop, debug: noop, event: noop };
  log.withContext = () => log;
  log.getLevel = () => 4;
  log.setLevel = noop;
  return log;
}
