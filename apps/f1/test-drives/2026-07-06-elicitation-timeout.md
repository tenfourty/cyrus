# Test Drive: elicitation timeout — unanswered AskUserQuestion resolves as a graceful deny, turn continues

**Date**: 2026-07-06
**Goal**: End-to-end validate `fix/elicitation-timeout`: when the agent posts a Linear "select"
elicitation via the `AskUserQuestion` tool and nobody answers within
`CYRUS_ELICITATION_TIMEOUT_MS`, the wait must resolve as a graceful deny (not a hang, not a
stall/abort) — the agent receives a "no response" note and continues the same turn.
**Test Repo**: `<scratch>/f1-elicitation-timeout/repo` (rate-limiter scaffold via
`./f1 init-test-repo`, disposable)
**Branch**: `fix/elicitation-timeout`

## Build step

Per protocol, ran the build first:

```
env -u CLAUDE_CODE_ENABLE_TELEMETRY pnpm build
```

All 17 workspace packages built clean, including `packages/edge-worker`.

## What this exercises

`AskUserQuestionHandler.ts` bounds the wait for a human answer to an `AskUserQuestion`
elicitation with `ELICITATION_TIMEOUT_MS` (default 15 min, overridable via
`CYRUS_ELICITATION_TIMEOUT_MS`, read once at module load). Three resolution paths — webhook
answer, session abort, and this new timeout — now funnel through a single settle-once `finish`
that clears the timer, removes the abort listener, and deletes the pending entry exactly once.
On fire, it logs:

```
No response to elicitation for session <id> within <ms>ms; proceeding without an answer
```

and resolves the pending promise with `{ answered: false, message: "No response was received
in N minutes, so I'm proceeding without an answer. If you want to steer this, reply on the
issue." }` — a graceful deny the agent can act on, not a session-level abort. This is distinct
from (and intentionally bounded well below) the stall watchdog's tool-in-flight budget (30 min
default), so an unanswered elicitation resolves long before the watchdog would ever consider
the turn stalled.

## Setup notes

- Repo config (`server.ts`, unmodified) uses team key `PRIMARY`; F1's default CLI-mode issue
  team key is `DEF`. This triggers the documented repository-selection elicitation on every
  session start (known F1 gotcha, unrelated to this feature) — resolved via `./f1 prompt-session
  --session-id <id> --message "F1 Test Repository"` before the feature-under-test's own
  elicitation can fire.
- Server started with `CYRUS_ELICITATION_TIMEOUT_MS=20000` (20s) plus `CYRUS_PORT`/
  `CYRUS_REPO_PATH`. Confirmed this reached the runner: `CYRUS_ELICITATION_TIMEOUT_MS` appears
  in the `cqo.envKeyNamesPreview` list of the session's `[event:claude_query_options]` log line,
  alongside `CYRUS_PORT` and `CYRUS_REPO_PATH`.
- Left `CYRUS_STALL_*` unset (defaults: 10-min idle / 30-min tool budget) so the stall watchdog
  could not plausibly fire anywhere near the 20s elicitation window — any observed resolution
  is unambiguously attributable to the elicitation timeout, not the watchdog.
- Issue description used the suggested coercive wording (ask for LRU vs FIFO eviction policy
  for a new in-memory cache on the rate limiter, explicit "do not proceed without asking"
  instruction, exactly one `AskUserQuestion` call). The agent called `AskUserQuestion` on the
  first attempt — no wording iteration was needed.

## Scenario — unanswered question → agent proceeds

**Server config**: `CYRUS_ELICITATION_TIMEOUT_MS=20000` (plus `CYRUS_PORT`/`CYRUS_REPO_PATH`).

**Issue**: "Add a simple in-memory cache to the rate limiter. Before writing any code, you MUST
use the AskUserQuestion tool to ask me which eviction policy to use (LRU vs FIFO) — this is a
genuinely ambiguous design decision and you must not guess. Call AskUserQuestion exactly once
with two options: LRU and FIFO. Do not proceed with any implementation until you have called the
tool and see a response (or a timeout/no-response note) in the tool result. Then, based on
whatever answer or fallback guidance you receive, implement the eviction policy in
`src/rate-limiter.ts`."

The elicitation was **not** answered on purpose.

### Timestamped log evidence

Elicitation posted (visible both as an activity and as the assistant's `tool_use` message
immediately preceding it):

```
7/6, 9:03:50 AM  thought       Before implementing, the issue requires me to ask about the ...
7/6, 9:03:50 AM  elicitation   Which eviction policy should the in-memory cache use?

• **LRU** ...
2026-07-06T09:03:50.078Z [event:message_emitted] {"messageType":"assistant", ...}   ← AskUserQuestion tool_use
```

Timeout resolution, ~20s later:

```
2026-07-06T09:04:10.180Z [INFO ] [AskUserQuestionHandler] No response to elicitation for session session-1 within 20000ms; proceeding without an answer
```

Gap from the elicitation-triggering assistant message (09:03:50.078Z) to the timeout log
(09:04:10.180Z) is **20.102s** — matching the configured 20000ms elicitation timeout almost
exactly.

The agent picked up the graceful-deny message and continued the same turn immediately, choosing
a default and proceeding to implement:

```
7/6, 9:04:15 AM  thought   No response received. I'll default to LRU as it's the more c...
7/6, 9:04:16 AM  action    Bash (List all files in the workt...
...
7/6, 9:04:37 AM  thought   No response received, so I'll default to LRU. Now I'll imple...
7/6, 9:04:42 AM  thought   ⏳ Add LRU in-memory cache to MemoryStorageAdapter
```

The turn ran through implementation, a typecheck, and a git commit, then reached a normal
completion:

```
2026-07-06T09:06:07.603Z [event:message_emitted] {"messageType":"result", ...}
2026-07-06T09:06:07.605Z [INFO ] [AgentSessionManager] Result message emitted to Linear (activity activity-62)
2026-07-06T09:06:07.605Z [INFO ] [AgentSessionManager] Session completed (subtype: success)
2026-07-06T09:06:10.542Z [event:session_completed] {"messageCount":173,"claudeSessionId":"<uuid>"}
```

**No hang, no stall, no abort.** A full-repository `grep -i stall` over the entire server log
for this run returned zero matches — no `session_stalled` event, no stall-watchdog log line, no
reconcile-to-`Stale` at any point. The only termination-adjacent events in the log are the
elicitation timeout line above and the ordinary `result` → `Session completed` → `
[event:session_completed]` success sequence.

**Server process never restarted**: the same OS process serving the F1 server (captured via
`pgrep` immediately after server start and again after session completion) was identical
throughout the whole scenario — only the per-turn Claude Code child process ran and exited
normally; the F1 server itself never crashed or respawned.

**Corroborating evidence in the worktree**: the agent's commit
(`feat(DEF-1): add LRU in-memory cache to rate limiter`) implements exactly the default the
"no response received" thought announced — a small `LRUCache<K, V>` class wired into
`MemoryStorageAdapter`, replacing the plain `Map`-backed store, plus a new `RateLimiterOptions`
surface for configuring it. This is strong independent confirmation that the agent didn't just
log a canned continuation message — it genuinely picked a default and executed real,
purpose-built implementation work afterward, matching the graceful-deny message's promise
("proceeding without an answer").

**Result: PASS.** The elicitation timeout fires at the configured bound (20s here), resolves as
a graceful deny (not a session abort), the agent picks a default and continues the turn to a
normal, successful completion, and the F1 server process is never disturbed.

### Confirming this is the timeout path, not the stall watchdog

- `CYRUS_STALL_*` was left at defaults (10-min idle / 30-min tool budget) — more than an order
  of magnitude larger than the 20s elicitation window used here, so the watchdog had no
  opportunity to fire coincidentally.
- Zero occurrences of `session_stalled`, `stall`, or `Stale` reconcile anywhere in the log for
  this run.
- The only log line attributing a termination-adjacent event names the elicitation handler
  explicitly: `[AskUserQuestionHandler] No response to elicitation for session ... within
  20000ms; proceeding without an answer` — a different component, a different message, and (per
  the source) a different code path than the stall watchdog's `onStall` → out-of-band
  termination → `Stale` reconcile flow.

## Fallback coverage

In addition to the live drive above, the handler's timeout behavior is unit-covered:

```
pnpm --filter cyrus-edge-worker exec vitest run test/AskUserQuestionHandler.timeout.test.ts
```

5/5 tests passed.

## Overall Pass/Fail

| Check | Expectation | Result |
|---|---|---|
| Induce exactly one `AskUserQuestion` elicitation | Coercive issue wording produces a single elicitation before any implementation | **PASS** (first attempt, no wording iteration needed) |
| Timeout fires at the configured bound | `proceeding without an answer` log line appears ~20s after the elicitation is posted | **PASS** (20.102s measured) |
| Agent continues the turn (not hung) | A default is chosen and implementation proceeds immediately after the timeout line | **PASS** |
| Turn reaches normal completion | `result` → `Session completed` → `[event:session_completed]`, no hang | **PASS** |
| Not a stall-watchdog event | No `session_stalled`, no `Stale` reconcile, no other "stall" log line anywhere | **PASS** |
| Server process stability | Same server process throughout; no restart/crash | **PASS** |
| Unit coverage | `AskUserQuestionHandler.timeout.test.ts` | **PASS** (5/5) |

## Final Retrospective

- The coercive issue wording ("you MUST use the AskUserQuestion tool ... do not proceed until
  you've asked") reliably produced exactly one elicitation on the first attempt — no need to
  iterate on the prompt.
- The measured timeout gap (20.102s against a configured 20000ms bound) lands almost exactly on
  the boundary, which is strong direct confirmation that the new `setTimeout`-based `finish`
  path — rather than some other incidental resolution — is what unblocked the agent.
  `timer.unref?.()` in the implementation also means this timer does not keep the Node process
  alive on its own, consistent with the server staying healthy and not needing special shutdown
  handling around it.
- The agent's post-timeout behavior wasn't just a courteous log message: it went on to actually
  implement the LRU cache it said it would default to, committed it, and ran a typecheck first —
  concrete evidence that the resolved promise value flows all the way back into the agent's
  live reasoning loop as usable tool output, not a dead-end error swallowed silently.
- The F1 CLI's `view-session` activity count under-reports versus what `AgentSessionManager`
  actually posted (it capped at 34 activities while the server log shows the session reached
  `activity-62` at completion) — this is the same kind of CLI-issue-tracker-bookkeeping display
  quirk noted in prior drives (the tracker's own polled snapshot lags the live
  `AgentSessionManager` state) and not evidence against the fix; the server log and worktree
  commit are the authoritative signals used for the pass verdict here.
- All server processes, the session, and the underlying Claude CLI subprocess were stopped/
  killed at the end of the drive; no server was left running.
