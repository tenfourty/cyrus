# Test Drive: session recovery reconciles against the real runner

**Date**: 2026-07-05
**Goal**: Verify end-to-end that a runner killed out of band gets reconciled to
`Error` and reaped, and that a re-ping respawns a new runner for the *same*
session with no daemon/process restart. Separately, resolve the spec's gating
risk: does `runner.stop()` (AbortController.abort()) actually reap a runner
whose child is genuinely hung (blocked on a never-responding network call), or
only a normally-running one?
**Test Repo**: `/var/tmp/.../scratchpad/f1-recovery-drive/repo` (rate-limiter
scaffold via `./f1 init-test-repo`, disposable)
**Branch**: `fix/session-recovery-reconcile-runner` (PR1, Tasks 1-6 already merged
on this branch)

## What this exercises

PR1 adds: `onTerminated` on the runner (fired when the query loop throws from
an out-of-band death, not a Cyrus-initiated stop) → EdgeWorker's
`reconcileTerminatedRunner` → `AgentSessionManager.markSessionStopped` (flips
status to `Error`, emits `session_terminal`) → a deferred (`setImmediate`)
`reconcileAndReap` that stops+clears the dead runner and reaps any warm
instance. A subsequent `agentSessionPrompted` webhook for that same session ID
(`handleNormalPromptedActivity`, "else" branch — session + repo already
resolved) then respawns a runner for the reconciled session instead of folding
into (or silently dropping into) a permanently-dead one.

## Setup

```bash
cd apps/f1
./f1 init-test-repo --path <scratch>/f1-recovery-drive/repo
CYRUS_PORT=3650 CYRUS_REPO_PATH=<scratch>/f1-recovery-drive/repo \
  bun run server.ts > <scratch>/f1-recovery-drive/server.log 2>&1 &
```

Repo config (`server.ts`, unmodified): `teamKeys: ["PRIMARY"]`. F1's default
CLI-mode team key is `DEF`, so every issue created here triggers the
documented repository-selection elicitation — resolved via
`./f1 prompt-session --session-id <id> --message "F1 Test Repository"` (per
the gotcha noted in the 2026-07-02 fallback-model drive). No `server.ts` edits
were needed or made for this drive.

## Scenario A — out-of-band kill → reconcile → re-ping → new runner (no restart)

1. `./f1 create-issue` (`DEF-1`) + `./f1 start-session --issue-id issue-1` →
   elicitation posted (`No routing match ... requesting user selection`).
2. `./f1 prompt-session --session-id session-1 --message "F1 Test Repository"`
   resolves the selection. Runner initializes:
   ```
   [event:session_started] {"workingDirectory":".../worktrees/DEF-1","model":"sonnet","fallbackModel":"haiku"}
   ```
3. Identified the actual OS child via `ps --ppid <bun-server-pid>`: a direct
   child running the bundled native `claude` binary
   (`.../claude-agent-sdk-linux-x64/claude ...`), PID `712813`.
4. Out-of-band kill: `kill -TERM 712813`. Confirmed the PID was gone
   (`ps -p 712813` → no such process) within ~1s.
5. Server log shows the exact reconcile chain, unprompted:
   ```
   [event:session_stopped] {"reason":"sigterm_unrequested","claudeSessionId":"5c21a897-..."}
   Runner for session session-1 terminated out of band (sigterm); reconciling to Error
   ```
   This is `ClaudeRunner`'s `classifyRunnerTermination` → `{kind:"crashed",reason:"sigterm"}`
   → `onTerminated` → `EdgeWorker.reconcileTerminatedRunner` →
   `markSessionStopped` (status → `Error`) → deferred `reconcileAndReap`
   (idempotent no-op stop since the runner already died; clears `agentRunner`).
6. Re-ping the **same session ID** (no new issue, no new session):
   `./f1 prompt-session --session-id session-1 --message "Please continue and add the requested one-line comment now."`
   Log:
   ```
   Marking session as resuming: status error → active
   [resumeAgentSession] needsNewSession=false, resumeSessionId=5c21a897-8a25-48ac-b5df-71d50bdfdccc
   [event:session_resumed] {"resumeSessionId":"5c21a897-...","workingDirectory":".../worktrees/DEF-1","model":"sonnet","fallbackModel":"haiku"}
   [event:claude_query_options] {"cqo.model":"sonnet",...,"cqo.resumeSessionId":"5c21a897-..."}
   ```
   The `status error → active` line is the internal proof: `AgentSessionManager`'s
   own record (not the F1 CLI-mode issue-tracker's separate bookkeeping — see
   Observability note below) really had flipped to `Error` in step 5, and this
   webhook flipped it back and respawned a runner for it.
7. `ps --ppid <bun-server-pid>` immediately after: a **new** PID (`714638`),
   distinct from the killed `712813`. `view-session` shows the conversation
   continuing (`prompt`, `thought: Getting started on that...`, `thought:
   Using model: claude-sonnet-4-6`, followed by real tool activity as it kept
   working).
8. Throughout steps 1-7 the same `bun run server.ts` process (PID `712149`)
   never restarted — verified by `ps --ppid 712149` continuously resolving
   before/after the kill and the re-ping.

**Result: PASS.** (a) out-of-band death reconciles the session to `Error`
without any external prompt; (b) the next `agentSessionPrompted` for that
exact session ID spawns a brand-new OS process and the conversation resumes;
(c) zero daemon/process restarts.

### Observability note (F1-CLI-mode quirk, not a bug)

`./f1 view-session`'s "Status" field reads `CLIIssueTrackerService`'s own
bookkeeping (Linear-facing agent-session status), which `markSessionStopped`/
`reconcileAndReap` do **not** touch — those only mutate
`AgentSessionManager`'s internal `CyrusAgentSession.status`, which is what
`decideSessionCreationAction`/`getActiveSessionsByIssueId` actually consult.
So `view-session` kept showing `Status: active` across the crash — that's
expected and not evidence of anything wrong; the `Marking session as resuming:
status error → active` log line is the real signal (it's printed from
`AgentSessionManager` and it says the pre-transition status literally was
`error`).

## Scenario B — abort-reaps-hung-child go/no-go (the spec's gating risk)

**Setup**: a local "black hole" TCP listener (`ncat -l -k 127.0.0.1 19999`)
that accepts connections and never responds. New issue/session (`DEF-3`,
`session-3`) resolved the same way as Scenario A, then killed OOB
(`kill -TERM <pid>`) to reconcile it to `Error` without going through
`stop-session` (which marks the F1 tracker's own status `Complete` and would
block a further `prompt-session`). Wrote
`.../worktrees/DEF-3/.env` with `ANTHROPIC_BASE_URL=http://127.0.0.1:19999`
(loaded per-turn by `ClaudeRunner.loadRepositoryEnv`, confirmed present in the
next turn's `cqo.envKeyNamesPreview`). Re-pinged `session-3` to force a new
spawn against the black hole.

Confirmed the new child (PID `719494`) was genuinely stuck, not just slow —
`ss -tnp` showed an `ESTAB` connection from the child to `127.0.0.1:19999`,
and the black-hole listener's capture showed a fully-formed, real
`POST /v1/messages?beta=true HTTP/1.1` request (with a live OAuth bearer
token) that received no response. No further session activity followed for
25+ elapsed seconds (well past this account's normal ~1-3s time-to-first-token).

Triggered the real EdgeWorker abort path (`./f1 stop-session --session-id
session-3`, which calls `emitStopSignalEvent` → `handleStopSignal` →
`runner.stop()` → `abortController.abort()`) and measured wall-clock time to
child-process exit in a single tight poll loop:

```
t=0ms:     stop-session issued (hung child pid 719494, ESTAB to black hole)
t=117ms:   stop-session RPC returned
t=124ms..1910ms: ps -p 719494 → alive (stat=Sl)
t=2267ms:  ps -p 719494 → alive (stat=Rl)   # just got signaled/scheduled
t=2625ms:  ps -p 719494 → GONE
```

Cyrus-level log corroborates the same ~2s window:
```
07:30:53.499 [EdgeWorker] Stopped session session-3 (interrupt not supported)
07:30:55.504 [EdgeWorker] [event:session_stopped] {"reason":"user_abort","claudeSessionId":"a87a2262-..."}
```

For comparison, the *normally-running* child in Scenario A's `stop-session`
(session-1, not hung) showed the same ~1.8-2s window before its query loop
broke and the process exited — i.e. the delay is not special-cased to hung
processes; it is the SDK's built-in abort→close grace period, and it reaped
both a healthy and a genuinely-hung child equally reliably.

**Root cause found while reading `@anthropic-ai/claude-agent-sdk`'s bundled
`sdk.mjs`**: `ProcessTransport.close()` (invoked when the query's
`AbortController` — the *same* one `ClaudeRunner.stop()` aborts — fires its
`abort` listener) unconditionally schedules, if the child hasn't already
exited: wait up to 2000ms, then `child.kill("SIGTERM")`; if still alive 5000ms
after that, `child.kill("SIGKILL")`. This kill schedule does not depend on
*why* the child hasn't exited — a genuinely hung child (blocked on a
never-responding HTTP read) is just as reachable by `SIGTERM`/`SIGKILL` as an
idle one, because sending a signal doesn't require the target to be doing
anything cooperative. In this run `SIGTERM` alone was sufficient (no
`SIGKILL` needed) for both the idle-child and the network-hung-child case.

**GO / NO-GO: GO.** `stop()` (AbortController.abort()) reaps a hung runner
child, not just a normally-running one, via the SDK's own built-in
2s-SIGTERM/+5s-SIGKILL escalation in `ProcessTransport.close()`. No code
change to `reconcileAndReap` (or anywhere else) is needed — `runner.stop()`
already does the job `reconcileAndReap` relies on it for, within ~2-3s in
practice, with a 7s worst-case bound from the SDK's own timers.

## Verification Results

### Issue-Tracker
- [x] Issues created (`DEF-1`, `DEF-2` unused/superseded, `DEF-3`), IDs returned
- [x] Repo-selection elicitation posted + resolved via `prompt-session`
      (team `DEF` ≠ repo `teamKeys: ["PRIMARY"]`, per the known F1 gotcha)

### EdgeWorker / Runner
- [x] `onTerminated` → `reconcileTerminatedRunner` → `markSessionStopped` fires
      on a real out-of-band `SIGTERM` kill of the actual OS child process
- [x] Deferred `reconcileAndReap` clears the dead runner without error
      (idempotent — the process was already gone)
- [x] `agentSessionPrompted` re-ping on the *same* session ID after
      reconciliation spawns a new OS process and resumes the underlying
      Claude conversation (`--resume <claudeSessionId>`)
- [x] No daemon/process restart at any point (verified via a stable bun
      server PID throughout)
- [x] `stop()`/abort reaps both a normally-running and a genuinely-hung
      (network-blocked) child within ~2-3 seconds

### Renderer / events
- [x] `[event:session_started]`, `[event:session_stopped]`,
      `[event:session_resumed]`, `[event:claude_query_options]` all present
      and well-formed across both scenarios

## Final Retrospective

- Real, working end-to-end validation of PR1's core promise: crash → `Error`
  → re-ping → recovery, with no daemon restart, confirmed against actual OS
  processes (not mocks) and actual EdgeWorker/AgentSessionManager logs.
- The gating risk (abort-reaps-hung-child) is resolved **GO** with a genuine
  network-hang reproduction (a real pending `/v1/messages` POST to a
  non-responding listener), not just an idle/sleeping child — and the SDK
  source explains *why* it's reliable (signal-based kill escalation,
  independent of what the child is blocked on).
- F1 usage gotcha (repeated from the 2026-07-02 drive): an issue whose team
  key doesn't match a repo's `teamKeys` triggers a repository-selection
  elicitation; the runner does not initialize until an `agentSessionPrompted`
  webhook (`./f1 prompt-session`) resolves it.
- New technique for future drives needing a "hung runner": write
  `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` into the issue's worktree
  `.env` (loaded per-turn by `ClaudeRunner.loadRepositoryEnv`) and point it at
  a local black-hole listener (`ncat -l -k <port>`). Cheap, deterministic, and
  doesn't require touching `server.ts` or any Cyrus config.
- No `apps/f1/server.ts` edits were made or needed for this drive (unlike the
  2026-07-02 drive) — the elicitation flow already provided everything
  needed.
