# Test Drive: stall watchdog — positive stall+recovery and negative tool-in-flight protection

**Date**: 2026-07-06
**Goal**: End-to-end validate the stall watchdog on `feat/stall-watchdog`: (S1) a hung turn
with no tool completes within the tool-in-flight budget aborts, the session reconciles to
`Stale` with a visible retry note, and a re-prompt on the same session recovers with a fresh
runner; (S2) a legitimately long *but bounded* silent tool call that exceeds the idle budget
but stays under the tool-in-flight budget must NOT be aborted — the turn completes normally.
**Test Repo**: `<scratch>/f1-stall-e2e/repo` (rate-limiter scaffold via `./f1 init-test-repo`,
disposable, reused for both scenarios)
**Branch**: `feat/stall-watchdog`

## Build step

Per protocol, ran the build first:

```
env -u CLAUDE_CODE_ENABLE_TELEMETRY pnpm build
```

All 17 workspace packages built clean, including `packages/claude-runner` and
`packages/edge-worker`.

## What this exercises

The watchdog (`packages/claude-runner/src/stallWatchdog.ts`) arms per active turn and picks
between two inactivity budgets:

- `CYRUS_STALL_IDLE_TIMEOUT_MS` — applies when no tool is currently in flight
  (`pendingToolCount === 0`).
- `CYRUS_STALL_TOOL_TIMEOUT_MS` — applies while a tool is in flight
  (`pendingToolCount > 0`), and is meant to be materially longer since a real tool
  (build, test run, long network call) can legitimately stay silent for a while.

On fire, `ClaudeRunner` logs `session_stalled` and aborts the turn. `EdgeWorker` catches the
resulting out-of-band termination, classifies `reason: "stall"`, posts a fixed warning
activity, and flips the session's internal status to `Stale` (recoverable — a later prompt
calls `markSessionResuming`, flipping `Stale → Active` and spawning a fresh runner resumed
against the same underlying Claude session id).

Both scenarios use `python3 -c "import time; time.sleep(N)"` as the blocking tool call. A
bare `sleep N` is blocked by Claude Code's own Bash-tool guard and gets rewritten to
`run_in_background: true`, which is a different code path (session held open for pending
background work, not a blocking `tool_use` → `tool_result` gap) and would not exercise the
watchdog's tool-in-flight branch at all. This gotcha, and the general SDK message-silence
shape during a blocking tool call, was characterized in a prior observation drive
(`2026-07-06-stall-watchdog-message-flow.md`) and is reused here.

## Setup notes (both scenarios)

- Repo config (`server.ts`, unmodified): `teamKeys: ["PRIMARY"]`. F1's default CLI-mode team
  key is `DEF`, so every issue here triggers the documented repository-selection
  elicitation — resolved via `./f1 prompt-session --session-id <id> --message "F1 Test
  Repository"` (known F1 gotcha, repeated from prior drives). No `server.ts` edits were made.
- The timeout env vars are read from the server process environment at `ClaudeRunner`
  construction time (per-session), not logged at server startup — confirmed by their
  presence in the `cqo.envKeyNamesPreview` list inside each session's
  `[event:claude_query_options]` log line.
- Each scenario used a fresh server process/port to avoid any doubt about stale env vars
  from a prior run.

---

## Scenario S1 — POSITIVE: stall fires on a hung, tool-in-flight turn, then recovers

**Server config**: `CYRUS_STALL_IDLE_TIMEOUT_MS=15000 CYRUS_STALL_TOOL_TIMEOUT_MS=20000`
(plus `CYRUS_PORT`/`CYRUS_REPO_PATH`).

**Issue**: instructed the agent to run exactly
`python3 -c "import time; time.sleep(60)"` as a single foreground Bash call (explicitly told
not to background/poll/monitor), then report done. Since a tool is in flight for the whole
60s, the ~20s tool-in-flight budget applies (not the 15s idle budget).

### Timestamped log evidence

```
2026-07-06T08:31:39.681Z [event:message_emitted] {"messageType":"assistant", ...}   ← tool_use: Bash "python3 -c \"...time.sleep(60)\""
2026-07-06T08:31:44.116Z [event:message_emitted] {"messageType":"system", ...}      ← internal tool-in-flight marker
2026-07-06T08:32:04.117Z [event:session_stalled] {"claudeSessionId":"2cf0850d-...","budgetMs":20000,"pendingToolCount":1}
2026-07-06T08:32:06.127Z [event:session_stopped] {"reason":"stall_unrequested","claudeSessionId":"2cf0850d-..."}
2026-07-06T08:32:06.127Z [WARN] Runner for session session-1 terminated out of band (stall); reconciling to Stale
```

Gap from the last message before the silence (08:31:44.116Z) to `session_stalled`
(08:32:04.117Z) is **20.001s** — matching the configured 20000ms tool budget almost exactly,
and `pendingToolCount:1` in the event payload confirms the watchdog was using the
tool-in-flight budget (not the 15s idle budget) because a tool was genuinely in flight.

The activity timeline (`./f1 view-session`) shows the retry note as the terminal activity for
this turn, with the exact wording specified by the feature:

```
7/6, 8:32:06 AM  error   ⚠️ This session stalled (no activity) and was stopped. Re-prompt to retry.
```

**Server PID never restarted**: `pgrep -af server.ts` returned the same PID
(observed before issue creation and again after the stall/reconcile) throughout the
scenario. The only thing that died was the per-turn Claude Code child process — confirmed by
`ps` finding no surviving `claude`/`python3 sleep` descendants of the F1 server immediately
after the reconcile.

**Recovery — re-prompting the same session**:

```
2026-07-06T08:34:24.464Z   (re-prompt sent: "Please continue.")
2026-07-06T08:34:24.569Z [INFO] Marking session as resuming: status stale → active
2026-07-06T08:34:24.608Z [event:session_resumed] {"resumeSessionId":"2cf0850d-...", ...}
2026-07-06T08:34:25.603Z [event:claude_session_id_assigned] {"claudeSessionId":"2cf0850d-..."}
```

`status stale → active` confirms the internal `AgentSessionManager` record (not just the F1
CLI's own separate issue-tracker bookkeeping — see observability note below) transitioned
correctly. A brand-new OS child process was spawned under the same server PID, invoked with
`--resume 2cf0850d-...` (the same underlying Claude session id as before the stall), and its
own `python3 -c "import time; time.sleep(60)"` sub-child confirmed the agent re-ran the
requested command on the resumed turn. The activity timeline shows the conversation
continuing (`prompt`, `thought: Getting started on that...`, `thought: Using model:
claude-sonnet-4-6`, `thought: Running the sleep command again`, a fresh `action` for the
Bash call) — a clean, coherent resume, not a fresh unrelated session.

**Result: PASS.** Stall fires at the configured tool-in-flight budget (not the shorter idle
budget) while a tool is genuinely in flight; the session reconciles to `Stale` with the exact
specified note; the server process never restarts; re-prompting the same session id recovers
cleanly with a fresh runner resumed against the same Claude session id.

### Observability note (F1-CLI-mode quirk, not a bug — previously documented)

`./f1 view-session`'s top-level "Status" field reads the CLI issue-tracker's own bookkeeping,
which `markSessionStale`/`markSessionResuming` do not touch — those mutate
`AgentSessionManager`'s internal session record, which is what the reconcile/resume/recovery
logic actually consults. So `view-session`'s "Status" line kept reading `active` across the
stall in this drive; that is expected (same quirk noted in the 2026-07-05 session-recovery
drive) and not evidence against the fix. The real signals are the `Marking session as
resuming: status stale → active` log line and the activity timeline content, both of which
are unambiguous above.

---

## Scenario S2 — NEGATIVE: a long-but-bounded silent tool must NOT be aborted

**Server config**: `CYRUS_STALL_IDLE_TIMEOUT_MS=15000 CYRUS_STALL_TOOL_TIMEOUT_MS=300000`
(idle short, tool long — restarted server, fresh port, same test repo).

**Issue**: instructed the agent to run exactly `python3 -c "import time; time.sleep(40)"`
via Bash, then report done. The 40s silent tool exceeds the 15s idle budget but is well under
the 300s tool budget — this is the case that would false-positive if the watchdog ever
degraded to the idle budget while a tool is in flight.

### Timestamped log evidence

```
2026-07-06T08:35:33.422Z [event:message_emitted] {"messageType":"system", ...}   ← last message before the silent window
2026-07-06T08:36:10.503Z [event:message_emitted] {"messageType":"system", ...}   ← next message, 37.081s later
2026-07-06T08:36:10.630Z [event:message_emitted] {"messageType":"user", ...}     ← tool_result
2026-07-06T08:36:12.054Z [event:message_emitted] {"messageType":"assistant", ...}
2026-07-06T08:36:12.181Z [event:message_emitted] {"messageType":"result", ...}
2026-07-06T08:36:12.186Z [INFO] Session completed (subtype: success)
2026-07-06T08:36:12.952Z [event:session_completed] {"messageCount":23,"claudeSessionId":"2e3c6021-..."}
```

37.081s of silence during the blocking tool call — well past the 15s idle budget, comfortably
under the 300s tool budget — produced **zero** `session_stalled` events (confirmed: `grep -c
session_stalled` on the full server log for this scenario returns `0`), and the turn
completed normally through `result` → `Session completed (subtype: success)` →
`[event:session_completed]`.

The activity timeline shows a clean, ordinary completion with no stall/error note:

```
7/6, 8:35:30 AM  thought   Running the 40-second sleep now.
7/6, 8:36:10 AM  action    Bash (Run 40-second blocking sleep) — completed
7/6, 8:36:12 AM  response  Done.
```

**Result: PASS.** This proves the tool-in-flight budget genuinely protects a legitimately
long silent tool — if the watchdog had wrongly applied the idle budget while a tool was in
flight, it would have aborted at ~15s instead of completing cleanly at ~40s+.

---

## Overall Pass/Fail

| Scenario | Expectation | Result |
|---|---|---|
| S1 (positive stall + recovery) | Watchdog fires at the tool budget while a tool is hung; session → `Stale` with the exact retry note; server never restarts; re-prompt recovers with a fresh runner | **PASS** |
| S2 (negative tool-awareness) | A silent tool that exceeds the idle budget but stays under the tool budget completes normally with no stall event | **PASS** |

The watchdog **does arm** in F1 CLI issue-session mode: `session_stalled` fired in S1 (as
expected) and did not fire in S2 (as expected), so `onTerminated` wiring for CLI issue
sessions is confirmed live end-to-end, not just in unit tests.

## Final Retrospective

- Both timing measurements landed almost exactly on the configured budget boundary (S1:
  20.001s against a 20000ms tool budget; S2: 37.081s of silence safely inside a 300000ms tool
  budget while exceeding the 15000ms idle budget by more than 2x) — strong, precise
  confirmation that `selectStallBudget` is choosing the tool-in-flight budget correctly, not
  just "eventually" catching a stall via some unrelated timeout.
- The F1 CLI's top-level session `Status` field is a known display quirk unrelated to this
  feature (it reads the CLI issue-tracker's own bookkeeping rather than
  `AgentSessionManager`'s internal status) — rely on the `status <old> → <new>` log lines and
  the activity timeline content instead, as previously documented in the 2026-07-05
  session-recovery drive.
- Reused the `python3 -c "import time; time.sleep(N)"` pattern from the prior message-flow
  observation drive to get a genuinely blocking, silent Bash call — a bare `sleep N` gets
  rewritten to `run_in_background: true` by Claude Code's own guard and would not exercise
  the tool-in-flight path at all.
- All server processes, sessions, and underlying Claude CLI subprocesses were stopped/killed
  at the end of each scenario; no server was left running.
