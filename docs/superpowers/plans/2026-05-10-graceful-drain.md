# Graceful Drain on Tool-Call Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `systemctl restart cyrus.service` (SIGTERM) wait for in-flight tool calls to finish before exiting, so deploys never kill `git push`/`repoA deploy`/`cargo build`/MCP HTTP calls mid-execution.

**Architecture:** New `DrainController` class subscribes to `tool_use`/`tool_result` events emitted by `AgentSessionManager`. On SIGTERM, `Application.shutdown()` enters drain mode: webhook layer returns 503 for new work, drain controller waits per-session until pending tool-use count reaches zero or hard cap fires. After drain, normal shutdown sequence runs and persistence flushes a clean snapshot. Auto-resume on next boot reads the snapshot and resumes from the post-tool boundary. SIGINT and a second SIGTERM bypass drain (immediate shutdown).

**Tech Stack:** TypeScript, pnpm monorepo, Vitest, Fastify (already used by `SharedApplicationServer`), Anthropic Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), Node.js EventEmitter.

---

## Design (review-revised v2)

### Predicate

Per-session counter tracked as `Map<sessionId, Set<toolUseId>>`:

- Add `id` on every `assistant` SDKMessage containing a `tool_use` content block.
- Remove `id` on every `user` SDKMessage containing a `tool_result` block whose `tool_use_id` matches an entry.
- Session is "drainable" when the set is empty. **Always also wait for the assistant message terminator** (next `assistant` text block with no pending tool_use, or a `result` SDKMessage); avoids burning rate-limit headroom re-running mid-completions on resume. Hard-coded; no knob.
- `result` SDKMessage with non-empty pending set → log warning + treat as drainable (terminal event already emitted; no further events coming).

**Runner fidelity:** Predicate is Claude-fidelity for `ClaudeRunner`. Codex/Cursor/Gemini runners synthesize Claude-shaped tool_use/tool_result pairs but do not currently emit a synthetic `tool_result` when their underlying CLI subprocess is killed mid-tool. To handle them safely v1, they fall through to per-session cap. v1.5 follow-up adds synthetic `tool_result` on subprocess abort; tracked but not in scope here.

### Trigger

- **SIGTERM (1st):** `running → draining`. Webhook layer flips. DrainController begins waiting.
- **SIGTERM (2nd):** treat as SIGINT. Immediate shutdown. Force-kill all subprocesses. Log `drain_aborted_by_second_signal`.
- **SIGINT:** immediate shutdown (escape hatch — current behavior).
- **POST `/admin/drain`:** initiate drain via HTTP without killing process; returns 202.
- **GET `/admin/drain/status`:** returns `{ state, sessions: [...], hardCapRemainingMs }`.
- No SIGUSR1.

### Webhook gating

States: `running → draining → shutting-down → exiting`.

- `running`: normal.
- `draining`: **all** session-spawning or session-prompting webhooks return 503 with `Retry-After: 30`. Includes `agentSessionPrompted` to in-process sessions (rejected to prevent starvation — operators must wait for drain to complete or use 2nd SIGTERM). `signal: stop` on existing sessions still accepted (treat that session as drainable immediately). Linear/Slack/GitHub all 503.
- `shutting-down`: all webhooks 503.
- `exiting`: process gone.

`shouldAbortSpawn` extended with new reason `"draining"`. Applied at every `runner.start()` boundary (already wired at 2 sites by prior work).

### Hard cap

- `drain.hardCapMs` global (default **1800000 = 30 min**). Wall-clock budget for entire drain; on expiry → log + force SIGTERM all subprocesses + persist force-kill markers + exit.
- `drain.perSessionCapMs` (default **1200000 = 20 min**). Defense-in-depth against missed `tool_result` event; that session marked drainable, others continue.
- Configurable via env `CYRUS_DRAIN_HARD_CAP_MS` / `CYRUS_DRAIN_PER_SESSION_CAP_MS` (millis). `0` disables drain (immediate shutdown like today). `perSessionCapMs` must be `<= hardCapMs` or DrainController throws on construct.
- systemd `TimeoutStopSec` must be `>= hardCapMs + 30s`. Documented in CHANGELOG; out of code scope.

**Honest framing:** drain reduces, does not eliminate, mid-tool restart hazard. A `cargo test --workspace` cold-cache run that exceeds 30min will still get force-killed.

### Force-kill marker

When DrainController force-kills a session with non-empty pending set, persist `lastInFlightToolUses: [{ id, name, killedAt }]` into that session's persisted state. On next boot, after auto-resume spawns the session, EdgeWorker reads + clears the marker and posts a Linear thought activity:

> ⚠️ Cyrus restarted while these tool calls were running. They may have partially completed: `Bash`, `mcp__linear__save_comment`. Verify before re-issuing.

### Architecture

New file: `packages/edge-worker/src/DrainController.ts`. Subscribes to `AgentSessionManager` events `tool_use_started` / `tool_use_completed`. Manages drain lifecycle. Owns no persistent state. Exposes:

```ts
class DrainController {
  state: DrainState;
  beginDrain(reason: DrainTrigger): Promise<DrainOutcome>;
  abortDrain(): void;  // for 2nd SIGTERM
  getStatus(): DrainStatus;
  getPendingToolUses(sessionId: string): Array<{ id, name, startedAt }>;
}
```

`AgentSessionManager` gets two new methods (`subscribeToolUseEvents(emitter)` style not needed; use `EventEmitter` extension) and emits the events near existing extractToolInfo / extractToolResultInfo sites.

`Application` wires `DrainController` and decides shutdown path based on signal.

`EdgeWorker` checks `drainController.state` in webhook handlers. `shouldAbortSpawn` accepts an optional `drainState` accessor and returns `"draining"` reason.

### Out of scope (v1)

- Synthetic `tool_result` on subprocess abort for Codex/Cursor/Gemini runners (filed as follow-up).
- In-memory webhook queue replay across restart (rely on Linear/Slack/GitHub native retry).
- Per-tool idempotency analysis or replay.
- Hot reload.
- Drain cancellation via API (cancel = 2nd SIGTERM).

---

## File Structure

**New files:**
- `packages/edge-worker/src/DrainController.ts` — drain lifecycle, predicate accounting, hard cap timers.
- `packages/edge-worker/src/DrainController.test.ts` — unit tests (vitest).
- `packages/edge-worker/src/drainTypes.ts` — shared types (`DrainState`, `DrainTrigger`, `DrainOutcome`, `DrainStatus`, `PendingToolUse`).

**Modified:**
- `packages/edge-worker/src/AgentSessionManager.ts` — emit `tool_use_started`/`tool_use_completed`/`session_terminal` events; expose `getPendingToolUseIds(sessionId)` for status query.
- `packages/edge-worker/src/shouldAbortSpawn.ts` — add `"draining"` reason; accept optional `isDraining()` accessor.
- `packages/edge-worker/src/EdgeWorker.ts` — instantiate DrainController; webhook gating in created/prompted handlers; register admin endpoints; pass drain accessor to `shouldAbortSpawn`; force-kill marker emit on shutdown; restore-marker-and-warn during auto-resume.
- `apps/cli/src/Application.ts` — track signal count; route 1st SIGTERM through DrainController; SIGINT and 2nd SIGTERM bypass.
- `packages/core/src/types.ts` (or wherever `CyrusAgentSession` lives) — add `lastInFlightToolUses?: Array<{ id; name; killedAt: string }>` field.
- `CHANGELOG.md` — Unreleased, `### Added`.
- `apps/cli/src/utils/applicationFactory.ts` (or wherever Application is constructed) — pass DrainController in.

---

## Task 1: Drain types module

**Files:**
- Create: `packages/edge-worker/src/drainTypes.ts`
- Test: (no direct test; types only)

- [ ] **Step 1: Create drainTypes.ts**

```ts
// packages/edge-worker/src/drainTypes.ts

export type DrainState =
  | "running"
  | "draining"
  | "shutting-down"
  | "exiting";

export type DrainTrigger = "sigterm" | "admin-endpoint" | "uncaught-exception";

export interface PendingToolUse {
  id: string;
  name: string;
  startedAt: number; // epoch ms
}

export interface DrainSessionStatus {
  sessionId: string;
  issueIdentifier?: string;
  pendingToolUses: PendingToolUse[];
  ageMs: number;
  perSessionCapRemainingMs: number;
}

export interface DrainStatus {
  state: DrainState;
  startedAt: number | null;
  hardCapRemainingMs: number | null;
  sessions: DrainSessionStatus[];
}

export type DrainOutcome =
  | { kind: "drained"; durationMs: number; sessionCount: number }
  | { kind: "force-killed"; durationMs: number; forcedSessions: ForcedSession[] }
  | { kind: "aborted-by-second-signal"; durationMs: number; forcedSessions: ForcedSession[] };

export interface ForcedSession {
  sessionId: string;
  pendingToolUses: PendingToolUse[];
}

export interface DrainConfig {
  hardCapMs: number;
  perSessionCapMs: number;
}

export const DEFAULT_DRAIN_CONFIG: DrainConfig = {
  hardCapMs: 30 * 60 * 1000,
  perSessionCapMs: 20 * 60 * 1000,
};

export function loadDrainConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DrainConfig {
  const hard = parseIntOr(env.CYRUS_DRAIN_HARD_CAP_MS, DEFAULT_DRAIN_CONFIG.hardCapMs);
  const per = parseIntOr(env.CYRUS_DRAIN_PER_SESSION_CAP_MS, DEFAULT_DRAIN_CONFIG.perSessionCapMs);
  return { hardCapMs: hard, perSessionCapMs: per };
}

function parseIntOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd packages/edge-worker && pnpm typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/edge-worker/src/drainTypes.ts
git commit -m "feat(edge-worker): drain types module for graceful-drain lifecycle"
```

---

## Task 2: AgentSessionManager emits tool_use lifecycle events

**Files:**
- Modify: `packages/edge-worker/src/AgentSessionManager.ts:519-552` (assistant case adds emit), `~570` (user case adds emit), `~554` (result case emits session_terminal). Plus class declaration line near top to extend EventEmitter (if not already).
- Test: `packages/edge-worker/test/AgentSessionManager.tool-events.test.ts` (new)

**Note for engineer:** AgentSessionManager already extends EventEmitter (verify by reading the class declaration; if not, add `extends EventEmitter`). The methods `extractToolInfo(sdkMessage)` and `extractToolResultInfo(sdkMessage)` already exist at lines ~765 and ~793 respectively — re-use them.

- [ ] **Step 1: Write failing test**

Create `packages/edge-worker/test/AgentSessionManager.tool-events.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import type { SDKAssistantMessage, SDKUserMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

function makeAssistantWithToolUse(id: string, name: string): SDKAssistantMessage {
  return {
    type: "assistant",
    session_id: "s1",
    message: {
      id: "msg_a",
      type: "message",
      role: "assistant",
      content: [{ type: "tool_use", id, name, input: {} }],
      model: "claude-x",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    parent_tool_use_id: null,
  } as any;
}

function makeUserWithToolResult(toolUseId: string): SDKUserMessage {
  return {
    type: "user",
    session_id: "s1",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }],
    },
    parent_tool_use_id: null,
  } as any;
}

describe("AgentSessionManager — tool-use lifecycle events", () => {
  let mgr: AgentSessionManager;

  beforeEach(() => {
    // Construct with whatever minimal deps the existing tests use; copy from
    // packages/edge-worker/test/AgentSessionManager.test.ts setup.
    mgr = new AgentSessionManager(/* ...deps... */);
  });

  it("emits tool_use_started when assistant message contains a tool_use block", async () => {
    const seen: any[] = [];
    mgr.on("tool_use_started", (ev) => seen.push(ev));

    await mgr.handleClaudeMessage("session-1", makeAssistantWithToolUse("toolu_1", "Bash"));

    expect(seen).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        toolUse: expect.objectContaining({ id: "toolu_1", name: "Bash" }),
      }),
    ]);
  });

  it("emits tool_use_completed when user message carries matching tool_result", async () => {
    const seen: any[] = [];
    mgr.on("tool_use_completed", (ev) => seen.push(ev));

    await mgr.handleClaudeMessage("session-1", makeAssistantWithToolUse("toolu_1", "Bash"));
    await mgr.handleClaudeMessage("session-1", makeUserWithToolResult("toolu_1"));

    expect(seen).toEqual([
      expect.objectContaining({ sessionId: "session-1", toolUseId: "toolu_1" }),
    ]);
  });

  it("emits session_terminal on result SDKMessage", async () => {
    const seen: any[] = [];
    mgr.on("session_terminal", (ev) => seen.push(ev));

    const resultMsg: SDKResultMessage = {
      type: "result",
      subtype: "success",
      session_id: "s1",
      duration_ms: 0,
      duration_api_ms: 0,
      is_error: false,
      num_turns: 1,
      result: "",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      uuid: "uuid",
    } as any;
    await mgr.handleClaudeMessage("session-1", resultMsg);

    expect(seen).toEqual([
      expect.objectContaining({ sessionId: "session-1" }),
    ]);
  });

  it("getPendingToolUseIds returns the open set", async () => {
    await mgr.handleClaudeMessage("s", makeAssistantWithToolUse("a", "Bash"));
    await mgr.handleClaudeMessage("s", makeAssistantWithToolUse("b", "Read"));
    expect(mgr.getPendingToolUseIds("s")).toEqual(new Set(["a", "b"]));

    await mgr.handleClaudeMessage("s", makeUserWithToolResult("a"));
    expect(mgr.getPendingToolUseIds("s")).toEqual(new Set(["b"]));
  });

  it("ignores duplicate tool_result for already-cleared id (replay safety)", async () => {
    const seen: any[] = [];
    mgr.on("tool_use_completed", (ev) => seen.push(ev));

    await mgr.handleClaudeMessage("s", makeAssistantWithToolUse("a", "Bash"));
    await mgr.handleClaudeMessage("s", makeUserWithToolResult("a"));
    await mgr.handleClaudeMessage("s", makeUserWithToolResult("a"));

    expect(seen).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd packages/edge-worker && pnpm vitest run test/AgentSessionManager.tool-events.test.ts`
Expected: FAIL — `mgr.on is not a function` or `getPendingToolUseIds is not a function`.

- [ ] **Step 3: Implement events + tracking in AgentSessionManager**

In `packages/edge-worker/src/AgentSessionManager.ts`:

a. Confirm `AgentSessionManager` extends `EventEmitter`. If not, add the import + `extends EventEmitter` to the class declaration.

b. Add private field near other Maps:

```ts
private pendingToolUseIdsBySession = new Map<string, Set<string>>();
private pendingToolUseMetadataBySession = new Map<string, Map<string, { name: string; startedAt: number }>>();
```

c. Add public method:

```ts
getPendingToolUseIds(sessionId: string): Set<string> {
  return new Set(this.pendingToolUseIdsBySession.get(sessionId) ?? []);
}

getPendingToolUseDetails(sessionId: string): Array<{ id: string; name: string; startedAt: number }> {
  const meta = this.pendingToolUseMetadataBySession.get(sessionId);
  if (!meta) return [];
  return Array.from(meta.entries()).map(([id, v]) => ({ id, name: v.name, startedAt: v.startedAt }));
}
```

d. In `processClaudeMessage`, in the `case "assistant":` branch (~line 519), after `extractToolInfo`-equivalent logic locates a tool_use block, emit. Add a helper just below the case:

Insert (after `assistantEntry` is created, before sync calls):

```ts
const toolInfo = this.extractToolInfo(message as SDKAssistantMessage);
if (toolInfo) {
  let ids = this.pendingToolUseIdsBySession.get(sessionId);
  if (!ids) {
    ids = new Set();
    this.pendingToolUseIdsBySession.set(sessionId, ids);
  }
  let meta = this.pendingToolUseMetadataBySession.get(sessionId);
  if (!meta) {
    meta = new Map();
    this.pendingToolUseMetadataBySession.set(sessionId, meta);
  }
  if (!ids.has(toolInfo.id)) {
    ids.add(toolInfo.id);
    meta.set(toolInfo.id, { name: toolInfo.name, startedAt: Date.now() });
    this.emit("tool_use_started", {
      sessionId,
      toolUse: { id: toolInfo.id, name: toolInfo.name, startedAt: meta.get(toolInfo.id)!.startedAt },
    });
  }
}
```

e. In `case "user":` branch (~line 510), after creating the user entry:

```ts
const toolResultInfo = this.extractToolResultInfo(message as SDKUserMessage);
if (toolResultInfo) {
  const ids = this.pendingToolUseIdsBySession.get(sessionId);
  const meta = this.pendingToolUseMetadataBySession.get(sessionId);
  if (ids?.has(toolResultInfo.toolUseId)) {
    ids.delete(toolResultInfo.toolUseId);
    meta?.delete(toolResultInfo.toolUseId);
    this.emit("tool_use_completed", {
      sessionId,
      toolUseId: toolResultInfo.toolUseId,
      isError: toolResultInfo.isError,
    });
  }
}
```

f. In `case "result":` branch (~line 554), before existing `completeSession` call:

```ts
const remaining = this.pendingToolUseIdsBySession.get(sessionId);
if (remaining && remaining.size > 0) {
  const log = this.sessionLog(sessionId);
  log.warn(
    `Session terminating with ${remaining.size} unmatched pending tool_use id(s); treating as drainable. Ids: ${[...remaining].join(", ")}`,
  );
}
this.pendingToolUseIdsBySession.delete(sessionId);
this.pendingToolUseMetadataBySession.delete(sessionId);
this.emit("session_terminal", { sessionId });
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd packages/edge-worker && pnpm vitest run test/AgentSessionManager.tool-events.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Run the full edge-worker suite to confirm no regressions**

Run: `cd packages/edge-worker && pnpm test:run`
Expected: PASS for all existing AgentSessionManager tests.

- [ ] **Step 6: Commit**

```bash
git add packages/edge-worker/src/AgentSessionManager.ts packages/edge-worker/test/AgentSessionManager.tool-events.test.ts
git commit -m "feat(edge-worker): emit tool_use lifecycle events from AgentSessionManager"
```

---

## Task 3: DrainController class

**Files:**
- Create: `packages/edge-worker/src/DrainController.ts`
- Create: `packages/edge-worker/test/DrainController.test.ts`

- [ ] **Step 1: Write failing tests (predicate, hard cap, per-session cap, abort)**

Create `packages/edge-worker/test/DrainController.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { DrainController } from "../src/DrainController.js";
import type { DrainConfig } from "../src/drainTypes.js";

interface FakeASM {
  on: (ev: string, fn: any) => void;
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

  it("transitions to 'draining' on beginDrain and resolves drained when all sessions empty", async () => {
    const asm = makeFakeAsm();
    (asm as any)._setActive(["s1"]);
    (asm as any)._setPending("s1", []);
    const dc = new DrainController({ agentSessionManager: asm as any, config: cfg, logger: silentLogger() });

    const promise = dc.beginDrain("sigterm");
    expect(dc.getState()).toBe("draining");

    asm.emit("session_terminal", { sessionId: "s1" });
    const outcome = await promise;
    expect(outcome.kind).toBe("drained");
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

  it("force-kills on hardCapMs expiry", async () => {
    const asm = makeFakeAsm();
    (asm as any)._setActive(["s1"]);
    (asm as any)._setPending("s1", [{ id: "a", name: "Bash", startedAt: Date.now() }]);
    const dc = new DrainController({ agentSessionManager: asm as any, config: cfg, logger: silentLogger() });

    const promise = dc.beginDrain("sigterm");
    vi.advanceTimersByTime(cfg.hardCapMs + 10);
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

  it("perSessionCap skips one stuck session and continues with others", async () => {
    const asm = makeFakeAsm();
    (asm as any)._setActive(["s1", "s2"]);
    (asm as any)._setPending("s1", [{ id: "stuck", name: "Bash", startedAt: Date.now() }]);
    (asm as any)._setPending("s2", []);
    const dc = new DrainController({ agentSessionManager: asm as any, config: cfg, logger: silentLogger() });

    const promise = dc.beginDrain("sigterm");
    asm.emit("session_terminal", { sessionId: "s2" });
    vi.advanceTimersByTime(cfg.perSessionCapMs + 10);
    const outcome = await promise;
    // s2 drained cleanly, s1 hit per-session cap and was treated as drainable.
    // Outcome shape: drained (cleanly), with s1 included in forcedSessions metadata if present.
    expect(["drained", "force-killed"]).toContain(outcome.kind);
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

  it("rejects construction when perSessionCapMs > hardCapMs", () => {
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
    const dc = new DrainController({ agentSessionManager: asm as any, config: { hardCapMs: 0, perSessionCapMs: 0 }, logger: silentLogger() });
    const outcome = await dc.beginDrain("sigterm");
    expect(outcome.kind).toBe("force-killed");
  });
});

function silentLogger() {
  const noop = () => undefined;
  const log: any = { info: noop, warn: noop, error: noop, debug: noop };
  log.withContext = () => log;
  return log;
}
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd packages/edge-worker && pnpm vitest run test/DrainController.test.ts`
Expected: FAIL — `Cannot find module '../src/DrainController.js'`.

- [ ] **Step 3: Implement DrainController**

Create `packages/edge-worker/src/DrainController.ts`:

```ts
import type { ILogger } from "cyrus-core";
import type { EventEmitter } from "node:events";
import type {
  DrainConfig,
  DrainOutcome,
  DrainSessionStatus,
  DrainState,
  DrainStatus,
  DrainTrigger,
  ForcedSession,
  PendingToolUse,
} from "./drainTypes.js";

interface AgentSessionManagerLike extends EventEmitter {
  getActiveAttachedSessionIds(): string[];
  getPendingToolUseDetails(sessionId: string): PendingToolUse[];
}

export interface DrainControllerInput {
  agentSessionManager: AgentSessionManagerLike;
  config: DrainConfig;
  logger: ILogger;
}

export class DrainController {
  private state: DrainState = "running";
  private startedAt: number | null = null;
  private hardCapTimer: NodeJS.Timeout | null = null;
  private perSessionTimers = new Map<string, NodeJS.Timeout>();
  private resolveOutcome: ((o: DrainOutcome) => void) | null = null;
  private outcomePromise: Promise<DrainOutcome> | null = null;
  private trackedSessions = new Set<string>();
  private aborted = false;

  constructor(private readonly input: DrainControllerInput) {
    if (input.config.perSessionCapMs > input.config.hardCapMs && input.config.hardCapMs > 0) {
      throw new Error("DrainController: perSessionCapMs must be <= hardCapMs");
    }
  }

  getState(): DrainState {
    return this.state;
  }

  isDraining(): boolean {
    return this.state === "draining" || this.state === "shutting-down";
  }

  beginDrain(trigger: DrainTrigger): Promise<DrainOutcome> {
    if (this.outcomePromise) return this.outcomePromise;
    const log = this.input.logger.withContext({ component: "DrainController" });
    this.state = "draining";
    this.startedAt = Date.now();

    if (this.input.config.hardCapMs === 0) {
      log.warn("Drain disabled (hardCapMs=0); proceeding to immediate force-kill outcome");
      const forced = this.snapshotForced();
      this.state = "shutting-down";
      return Promise.resolve({ kind: "force-killed", durationMs: 0, forcedSessions: forced });
    }

    log.info(`Drain started (trigger=${trigger}, hardCapMs=${this.input.config.hardCapMs})`);

    this.outcomePromise = new Promise<DrainOutcome>((resolve) => {
      this.resolveOutcome = resolve;
    });

    this.trackedSessions = new Set(this.input.agentSessionManager.getActiveAttachedSessionIds());

    // Start per-session timers
    for (const sid of this.trackedSessions) {
      this.armPerSessionTimer(sid);
    }

    // Subscribe to events
    this.input.agentSessionManager.on("session_terminal", this.onSessionTerminal);
    this.input.agentSessionManager.on("tool_use_completed", this.onToolUseCompleted);

    // Hard cap
    this.hardCapTimer = setTimeout(() => this.onHardCapExpired(), this.input.config.hardCapMs);

    // Initial check (some sessions may already be drainable)
    this.evaluate();

    return this.outcomePromise;
  }

  abortDrain(): void {
    if (this.state !== "draining") return;
    this.aborted = true;
    const log = this.input.logger.withContext({ component: "DrainController" });
    log.warn("Drain aborted by second signal — proceeding to immediate shutdown");
    const forced = this.snapshotForced();
    this.cleanup();
    this.state = "shutting-down";
    this.resolveOutcome?.({
      kind: "aborted-by-second-signal",
      durationMs: this.elapsedMs(),
      forcedSessions: forced,
    });
  }

  getStatus(): DrainStatus {
    const sessions: DrainSessionStatus[] = [];
    for (const sid of this.trackedSessions) {
      const pending = this.input.agentSessionManager.getPendingToolUseDetails(sid);
      const ageMs = this.startedAt ? Date.now() - this.startedAt : 0;
      const perSessionRemaining = this.input.config.perSessionCapMs - ageMs;
      sessions.push({
        sessionId: sid,
        pendingToolUses: pending,
        ageMs,
        perSessionCapRemainingMs: Math.max(0, perSessionRemaining),
      });
    }
    return {
      state: this.state,
      startedAt: this.startedAt,
      hardCapRemainingMs: this.startedAt
        ? Math.max(0, this.input.config.hardCapMs - this.elapsedMs())
        : null,
      sessions,
    };
  }

  private onSessionTerminal = (ev: { sessionId: string }) => {
    if (!this.trackedSessions.has(ev.sessionId)) return;
    this.markSessionDone(ev.sessionId);
  };

  private onToolUseCompleted = (_ev: { sessionId: string; toolUseId: string }) => {
    this.evaluate();
  };

  private armPerSessionTimer(sessionId: string): void {
    if (this.input.config.perSessionCapMs === 0) return;
    const t = setTimeout(() => {
      const log = this.input.logger.withContext({ component: "DrainController", sessionId });
      log.warn(
        `Per-session cap (${this.input.config.perSessionCapMs}ms) hit for session ${sessionId}; treating as drainable`,
      );
      this.markSessionDone(sessionId);
    }, this.input.config.perSessionCapMs);
    this.perSessionTimers.set(sessionId, t);
  }

  private markSessionDone(sessionId: string): void {
    this.trackedSessions.delete(sessionId);
    const t = this.perSessionTimers.get(sessionId);
    if (t) {
      clearTimeout(t);
      this.perSessionTimers.delete(sessionId);
    }
    this.evaluate();
  }

  private evaluate(): void {
    if (this.aborted || this.state !== "draining") return;
    // Drainable if all tracked sessions have empty pending sets
    let allEmpty = true;
    for (const sid of this.trackedSessions) {
      if (this.input.agentSessionManager.getPendingToolUseDetails(sid).length > 0) {
        allEmpty = false;
        break;
      }
    }
    if (this.trackedSessions.size === 0 || allEmpty) {
      this.cleanup();
      this.state = "shutting-down";
      this.resolveOutcome?.({
        kind: "drained",
        durationMs: this.elapsedMs(),
        sessionCount: this.trackedSessions.size,
      });
    }
  }

  private onHardCapExpired(): void {
    const log = this.input.logger.withContext({ component: "DrainController" });
    log.error(`Hard cap (${this.input.config.hardCapMs}ms) hit during drain — force-killing remaining sessions`);
    const forced = this.snapshotForced();
    this.cleanup();
    this.state = "shutting-down";
    this.resolveOutcome?.({
      kind: "force-killed",
      durationMs: this.elapsedMs(),
      forcedSessions: forced,
    });
  }

  private snapshotForced(): ForcedSession[] {
    const out: ForcedSession[] = [];
    for (const sid of this.trackedSessions) {
      const pending = this.input.agentSessionManager.getPendingToolUseDetails(sid);
      if (pending.length > 0) out.push({ sessionId: sid, pendingToolUses: pending });
    }
    return out;
  }

  private elapsedMs(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  private cleanup(): void {
    this.input.agentSessionManager.off("session_terminal", this.onSessionTerminal);
    this.input.agentSessionManager.off("tool_use_completed", this.onToolUseCompleted);
    if (this.hardCapTimer) {
      clearTimeout(this.hardCapTimer);
      this.hardCapTimer = null;
    }
    for (const t of this.perSessionTimers.values()) clearTimeout(t);
    this.perSessionTimers.clear();
  }
}
```

- [ ] **Step 4: Add `getActiveAttachedSessionIds()` to AgentSessionManager**

Add to `packages/edge-worker/src/AgentSessionManager.ts`:

```ts
/**
 * Return sessions that have an attached claudeRunner (excludes dormant). Used by
 * DrainController to decide which sessions to wait on during shutdown.
 */
getActiveAttachedSessionIds(): string[] {
  const ids: string[] = [];
  for (const [id, session] of this.sessions.entries()) {
    if (session.claudeRunner) ids.push(id);
  }
  return ids;
}
```

(Engineer: confirm the existing field name for "the in-memory session map" — it's `this.sessions` per existing get/set patterns. If named differently, adjust.)

- [ ] **Step 5: Run tests, verify they pass**

Run: `cd packages/edge-worker && pnpm vitest run test/DrainController.test.ts`
Expected: PASS for all 8 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/edge-worker/src/DrainController.ts packages/edge-worker/test/DrainController.test.ts packages/edge-worker/src/AgentSessionManager.ts
git commit -m "feat(edge-worker): DrainController coordinates wait-for-tool-boundary shutdown"
```

---

## Task 4: Extend shouldAbortSpawn with 'draining' reason

**Files:**
- Modify: `packages/edge-worker/src/shouldAbortSpawn.ts`
- Modify: `packages/edge-worker/test/shouldAbortSpawn.test.ts`

- [ ] **Step 1: Write failing test**

Append to `packages/edge-worker/test/shouldAbortSpawn.test.ts`:

```ts
it("returns 'draining' when isDraining() returns true", () => {
  const session = makeSession({ existingPath: tmpExistingPath });
  const result = shouldAbortSpawn({
    session,
    agentSessionManager: makeAsm({ has: true, stopRequested: false }),
    isDraining: () => true,
    logger: silentLogger(),
  });
  expect(result).toBe("draining");
});

it("ignores draining accessor when undefined (back-compat)", () => {
  const session = makeSession({ existingPath: tmpExistingPath });
  const result = shouldAbortSpawn({
    session,
    agentSessionManager: makeAsm({ has: true, stopRequested: false }),
    logger: silentLogger(),
  });
  expect(result).toBeNull();
});
```

(Engineer: re-use existing helpers `makeSession`, `makeAsm`, `silentLogger`, `tmpExistingPath` from the existing test file.)

- [ ] **Step 2: Run, verify FAIL**

Run: `cd packages/edge-worker && pnpm vitest run test/shouldAbortSpawn.test.ts`
Expected: FAIL — extra `isDraining` arg ignored or "draining" not returned.

- [ ] **Step 3: Update shouldAbortSpawn.ts**

```ts
export type SpawnAbortReason =
  | "session-removed"
  | "stop-requested"
  | "worktree-missing"
  | "draining";

export interface ShouldAbortSpawnInput {
  session: CyrusAgentSession;
  agentSessionManager: AgentSessionManagerLike;
  logger: ILogger;
  isDraining?: () => boolean;
}

// In the function, immediately after the stop-requested check, add:
if (input.isDraining?.()) {
  log.info("Aborting runner spawn: drain in progress, refusing to spawn new work");
  return "draining";
}
```

- [ ] **Step 4: Run tests, verify PASS**

Run: `cd packages/edge-worker && pnpm vitest run test/shouldAbortSpawn.test.ts`
Expected: all PASS (existing 7 + new 2 = 9).

- [ ] **Step 5: Commit**

```bash
git add packages/edge-worker/src/shouldAbortSpawn.ts packages/edge-worker/test/shouldAbortSpawn.test.ts
git commit -m "feat(edge-worker): shouldAbortSpawn returns 'draining' when drain active"
```

---

## Task 5: EdgeWorker drain integration — webhook gating + admin endpoints + force-kill marker persistence

**Files:**
- Modify: `packages/edge-worker/src/EdgeWorker.ts` (constructor wires DrainController; webhook handlers gate; new endpoints registered; force-kill marker hook in stop())
- Modify: `packages/edge-worker/src/types.ts` (or `packages/core/src/types.ts` — wherever `CyrusAgentSession` lives) to add `lastInFlightToolUses?` field
- Test: `packages/edge-worker/test/EdgeWorker.drain-integration.test.ts` (new)

- [ ] **Step 1: Add field to session state type**

Find `CyrusAgentSession` definition. Add:

```ts
lastInFlightToolUses?: Array<{
  id: string;
  name: string;
  killedAt: string; // ISO
}>;
```

- [ ] **Step 2: Write failing tests**

Create `packages/edge-worker/test/EdgeWorker.drain-integration.test.ts`. Mirror existing EdgeWorker test setup (copy mocks from `EdgeWorker.parent-branch.test.ts`). Add tests:

```ts
describe("EdgeWorker — drain integration", () => {
  // setup with mocked DrainController spy & SharedApplicationServer fastify spy

  it("registers POST /admin/drain and GET /admin/drain/status on the shared server", () => {
    // assert fastify.post called with "/admin/drain"
    // assert fastify.get called with "/admin/drain/status"
  });

  it("returns 503 from handleAgentSessionCreatedWebhook when drain controller isDraining()", async () => {
    drainControllerStub.isDraining = () => true;
    const reply = await invokeWebhook(/* createdWebhook */);
    expect(reply.statusCode).toBe(503);
    expect(reply.headers["retry-after"]).toBe("30");
  });

  it("returns 503 from handleUserPromptedAgentActivity (non-stop) during drain", async () => {
    drainControllerStub.isDraining = () => true;
    const reply = await invokeWebhook(/* promptedWebhook with body, not stop signal */);
    expect(reply.statusCode).toBe(503);
  });

  it("accepts stop-signal prompted webhook even during drain", async () => {
    drainControllerStub.isDraining = () => true;
    const reply = await invokeWebhook(/* promptedWebhook with signal: 'stop' */);
    expect(reply.statusCode).toBe(200);
  });

  it("persists lastInFlightToolUses for force-killed sessions", async () => {
    // simulate drain outcome force-killed with one session pending
    // call edgeWorker.stop()
    // assert savePersistedState received session with lastInFlightToolUses populated
  });

  it("clears + posts Linear warning for sessions resumed with lastInFlightToolUses marker", async () => {
    // arrange persisted state with marker
    // call auto-resume entry
    // assert AgentActivity create called with content matching "may have partially completed"
    // assert marker cleared after post
  });
});
```

(Engineer: fill in the webhook invocation helper using existing mock patterns. The exact return-shape from webhook handlers needs to be checked — they currently return `void` and call `reply.status(...).send(...)`. May need to mock fastify reply object.)

- [ ] **Step 3: Run, verify FAIL**

Run: `cd packages/edge-worker && pnpm vitest run test/EdgeWorker.drain-integration.test.ts`
Expected: FAIL across all 6.

- [ ] **Step 4: Implement EdgeWorker changes**

a. **Constructor:** instantiate DrainController. Add field `private drainController: DrainController`. Wire after `agentSessionManager` is constructed. Pull config via `loadDrainConfigFromEnv()`.

b. **`shouldAbortSpawn` callsites:** add `isDraining: () => this.drainController.isDraining()` to both invocations (existing locations: lines ~4317 and ~6776 per the prior fix).

c. **`handleAgentSessionCreatedWebhook` (line ~4043):** at top of method, after parsing webhook, add:

```ts
if (this.drainController.isDraining()) {
  this.logger.warn(`Refusing agentSessionCreated during drain (sessionId=${webhook.agentSession?.id})`);
  return reply.status(503).header("Retry-After", "30").send({ error: "draining" });
}
```

(Engineer: existing handler signature uses `(webhook, repositories)` — that's invoked from webhook router. Find the actual fastify reply path: Linear webhooks land at a route registered somewhere; the 503 logic should live at that route, then NOT call the handler at all. Trace from `LinearEventTransport`/`MessageBus` to the route. Adapt accordingly — likely the gate goes one layer up.)

d. **`handleUserPromptedAgentActivity` (line ~4874):** same pattern; but **do not** 503 if `agentActivity.signal === "stop"`. Stop signal must always be accepted during drain so operators can cancel a stuck session.

e. **Admin endpoints:** alongside `registerStatusEndpoint` (line 866), add `registerDrainEndpoints`:

```ts
private registerDrainEndpoints(): void {
  const fastify = this.sharedApplicationServer.getFastifyInstance();

  fastify.post("/admin/drain", async (_req, reply) => {
    if (this.drainController.isDraining()) {
      return reply.status(409).send({ error: "drain-already-in-progress" });
    }
    // Fire-and-forget; caller polls /admin/drain/status. After drain completes,
    // process exits via the normal shutdown path, since a drain triggered via
    // admin endpoint must still end the process (operator's intent is "prepare
    // for restart"). Application sets up a hook for this — see Task 6.
    this.beginAdminDrain();
    return reply.status(202).send({ state: "draining" });
  });

  fastify.get("/admin/drain/status", async (_req, reply) => {
    return reply.status(200).send(this.drainController.getStatus());
  });

  this.logger.info("✅ Admin drain endpoints registered (POST /admin/drain, GET /admin/drain/status)");
}
```

Add `beginAdminDrain()` method. It calls `this.drainController.beginDrain("admin-endpoint")` and then `process.kill(process.pid, "SIGTERM")` (or directly invokes the shutdown path) once the drain completes. Engineer: prefer raising SIGTERM after admin-drain so the existing Application shutdown handler fires; this avoids duplicating shutdown logic.

f. **Force-kill marker write in `stop()`:** in `EdgeWorker.stop()` (line ~2400), accept an optional `forceKillOutcome?: DrainOutcome` parameter. If outcome is `force-killed` or `aborted-by-second-signal`, iterate `outcome.forcedSessions`, mutate the corresponding session in `agentSessionManager` to set `lastInFlightToolUses` (mapping pendingToolUses → field shape with ISO killedAt), THEN call `savePersistedState()`. The persisted file then carries the markers.

g. **Auto-resume marker handling:** in the auto-resume code (around line 6320, `runAutoResumeOrchestrator`), after a session is successfully resumed, if `session.lastInFlightToolUses?.length > 0`:

   - Post a Linear thought activity via `agentSessionManager.createThoughtActivity({...})` with body:
     ```
     ⚠️ Cyrus restarted while these tool calls were running. They may have partially completed: <list of tool names>. Verify before re-issuing.
     ```
   - Clear `session.lastInFlightToolUses = undefined` and persist.

(Engineer: re-use `postAnalyzingThought` or equivalent activity-posting helper that the auto-resume flow uses for its existing notifications.)

- [ ] **Step 5: Run tests, verify PASS**

Run: `cd packages/edge-worker && pnpm vitest run test/EdgeWorker.drain-integration.test.ts`
Expected: all 6 PASS.

- [ ] **Step 6: Run full edge-worker suite**

Run: `cd packages/edge-worker && pnpm test:run`
Expected: all PASS. Some existing tests may need their AgentSessionManager mocks updated to include the new `getActiveAttachedSessionIds` and EventEmitter `on`/`off` methods. Add as needed (`vi.fn().mockReturnValue([])`).

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck` from repo root.
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/edge-worker/src/EdgeWorker.ts packages/edge-worker/test/EdgeWorker.drain-integration.test.ts packages/core/src/types.ts packages/edge-worker/src/types.ts packages/edge-worker/src/AgentSessionManager.ts
git commit -m "feat(edge-worker): wire DrainController into webhook gating, admin endpoints, and force-kill markers"
```

---

## Task 6: Application.shutdown — SIGTERM → drain → exit, SIGINT/2nd SIGTERM bypass

**Files:**
- Modify: `apps/cli/src/Application.ts:331-401`
- Test: `apps/cli/src/Application.shutdown.test.ts` (new)

- [ ] **Step 1: Write failing test**

Create `apps/cli/src/Application.shutdown.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Application } from "./Application.js";

describe("Application.shutdown — drain integration", () => {
  let drainBeginSpy: any;
  let drainAbortSpy: any;
  let workerStopSpy: any;

  beforeEach(() => {
    // construct Application with stubbed worker, errorReporter, logger, drainController
  });

  it("first SIGTERM enters drain, awaits outcome, then stops worker and exits", async () => {
    // arrange: drainController.beginDrain returns { kind: 'drained', durationMs: 100, sessionCount: 0 }
    // act: emit SIGTERM
    // assert: drainBeginSpy called once with 'sigterm'
    // assert: workerStopSpy called once after drain resolves
    // assert: process.exit(0)
  });

  it("second SIGTERM during drain calls drainController.abortDrain()", async () => {
    // first SIGTERM begins drain (pending)
    // second SIGTERM emitted
    // assert: drainAbortSpy called once
  });

  it("SIGINT bypasses drain entirely", async () => {
    // emit SIGINT
    // assert: drainBeginSpy NOT called
    // assert: workerStopSpy called immediately
  });

  it("uncaughtException bypasses drain entirely (use existing immediate path)", async () => {
    // emit uncaughtException
    // assert: drainBeginSpy NOT called
    // assert: process.exit(1)
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd apps/cli && pnpm vitest run src/Application.shutdown.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement Application changes**

In `apps/cli/src/Application.ts`:

a. Add field `private sigtermCount = 0;` and inject `drainController: DrainController` via constructor (engineer: locate where Application is constructed in `applicationFactory.ts` or similar; pass through from EdgeWorker since EdgeWorker owns DrainController. May need to expose a `worker.getDrainController()` accessor).

b. Refactor `setupSignalHandlers`:

```ts
process.on("SIGTERM", () => {
  this.sigtermCount += 1;
  if (this.sigtermCount === 1) {
    this.logger.info("Received SIGTERM, entering drain mode...");
    void this.drainAndShutdown("sigterm");
  } else {
    this.logger.warn(`Received SIGTERM #${this.sigtermCount}, aborting drain and shutting down immediately`);
    this.drainController.abortDrain();
    void this.shutdown();
  }
});

process.on("SIGINT", () => {
  this.logger.info("Received SIGINT, shutting down immediately...");
  void this.shutdown();
});
```

c. Add `drainAndShutdown(trigger)` method:

```ts
private async drainAndShutdown(trigger: DrainTrigger): Promise<void> {
  if (this.shutdownPromise) return this.shutdownPromise;
  this.shutdownPromise = (async () => {
    let outcome: DrainOutcome | null = null;
    try {
      outcome = await this.drainController.beginDrain(trigger);
      this.logger.info(`Drain finished (kind=${outcome.kind}, durationMs=${outcome.durationMs})`);
    } catch (err) {
      this.logger.error("Drain controller threw; proceeding to immediate shutdown", err as Error);
    }
    await this.performShutdown(outcome);
  })();
  return this.shutdownPromise;
}
```

d. Update `performShutdown` to accept optional outcome and forward to `worker.stop(outcome)`:

```ts
private async performShutdown(outcome?: DrainOutcome | null): Promise<void> {
  if (this.envWatcher) this.envWatcher.close();
  if (this.configWatcher) this.configWatcher.close();
  await this.worker.stop(outcome ?? undefined);
  await this.errorReporter.flush(2000).catch(() => false);
  process.exit(0);
}
```

e. Keep `shutdown()` (without drain) as the immediate-path entrypoint used by SIGINT and uncaughtException.

- [ ] **Step 4: Run tests, verify PASS**

Run: `cd apps/cli && pnpm vitest run src/Application.shutdown.test.ts`
Expected: all 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/Application.ts apps/cli/src/Application.shutdown.test.ts apps/cli/src/utils/applicationFactory.ts
git commit -m "feat(cli): SIGTERM enters drain mode; SIGINT and 2nd SIGTERM bypass"
```

---

## Task 7: CHANGELOG + docs

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add to CHANGELOG.md under `## [Unreleased]` → `### Added`**

```markdown
- Graceful drain on shutdown: cyrus now defers SIGTERM until each active session reaches a tool-call boundary (no `tool_use` waiting on a `tool_result`). Restart no longer interrupts in-flight tool execution like `git push`, `cargo build`, `repoA deploy`, or MCP HTTP requests; LLM completions may still get interrupted but resume cleanly via session-id resume. Drain has a configurable hard cap (default 30 minutes; set `CYRUS_DRAIN_HARD_CAP_MS` to change, `0` to disable). When the hard cap fires, force-killed sessions persist a marker that triggers a Linear warning activity on the next resume so operators know which tool calls may have partially completed. New endpoints `POST /admin/drain` (initiate) and `GET /admin/drain/status` (live status). A second SIGTERM during drain aborts and proceeds to immediate shutdown. Webhooks for new sessions and prompts return `503 Retry-After: 30` during drain so Linear's native retry picks them up after restart. **Operator note:** ensure `systemd TimeoutStopSec` is at least `CYRUS_DRAIN_HARD_CAP_MS + 30s`.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog entry for graceful drain"
```

---

## Task 8: Final verification

- [ ] **Step 1: Full repo typecheck + tests + lint**

Run:
```bash
pnpm typecheck
pnpm test:packages:run
pnpm lint
```
Expected: all PASS clean.

- [ ] **Step 2: Manual smoke (optional but recommended)**

On staging agentHost or local:
1. Start cyrus with `CYRUS_DRAIN_HARD_CAP_MS=60000 CYRUS_DRAIN_PER_SESSION_CAP_MS=30000`.
2. Trigger a session with a slow Bash tool call (e.g., `sleep 20`).
3. Send `kill -TERM <pid>` mid-tool.
4. Observe logs: `Drain started`, then `Session X became drainable`, then `Drain finished kind=drained`, then exit.
5. Check `/admin/drain/status` during drain shows pending tool.
6. Repeat with `sleep 120` (exceeds hard cap) — observe force-kill, then restart cyrus and verify Linear gets a "may have partially completed" warning posted.

- [ ] **Step 3: Push to tenfourty remote**

```bash
git push tenfourty feat/graceful-drain
```

(No upstream PR yet — wait for user signal.)

---

## Self-Review Notes

- **Predicate fidelity for non-Claude runners** is acknowledged as v1 limitation (Codex/Cursor/Gemini fall through to per-session cap). Track as v1.5 follow-up: emit synthetic `tool_result` on subprocess abort in those runners.
- **systemd TimeoutStopSec coupling** is documented (CHANGELOG operator note) but not enforced in code. Could add a startup check that warns if `process.env.NOTIFY_SOCKET` indicates systemd and a low TimeoutStopSec is detectable; deferred for now.
- **Admin endpoint auth** — assumes existing `SharedApplicationServer` admin-endpoint auth pattern is reused. Engineer: verify `/admin/*` routes already have a token check; if not, add one that matches `/status`.
- **Linear comment for force-kill** is posted from auto-resume on next boot, not at force-kill time, because the process is exiting. This is correct: the warning is for the resumed agent's next operator interaction.
- **DrainController owns no persistent state** — all drain state is in-memory and lost on hard kill. That's intentional (drain is by definition pre-shutdown coordination; the persistent footprint is the force-kill marker on session state).
- **Order of fields in `DrainOutcome`** ensures discriminated union narrowing works — engineer should confirm exhaustive switch coverage.

