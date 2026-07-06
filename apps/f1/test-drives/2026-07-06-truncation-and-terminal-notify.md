# Test Drive: turn truncation stays Complete, out-of-band death gets a visible retry notice

**Date**: 2026-07-06
**Goal**: End-to-end validate two related fixes on `fix/surface-truncated-and-errored-turns`:
(1) a `max_output_tokens`-truncated turn keeps status `Complete` and posts a visible
error-type note as the last activity instead of silently looking finished, and
(2) a runner that dies out of band (crash/kill/thrown error) posts a "stopped
unexpectedly ... re-prompt to retry" notice and the session recovers cleanly on
the next prompt.
**Test Repo**: `.../scratchpad/f1-truncation-drive/repo` (rate-limiter scaffold via
`./f1 init-test-repo`, disposable)
**Branch**: `fix/surface-truncated-and-errored-turns`

## Build step

Per protocol, ran the build first so F1 picks up the edge-worker changes:

```
env -u CLAUDE_CODE_ENABLE_TELEMETRY pnpm build
```

All 17 workspace packages built clean, including `packages/edge-worker` and `apps/f1`.

## What this exercises

Three commits on the branch:

1. `isTruncatedTurn` helper — classifies a `result` message as a truncated turn
   when it's an otherwise-clean `subtype:"success"`/`is_error:false` envelope
   AND either the last assistant message's SDK `error` field is
   `"max_output_tokens"` or `resultMessage.stop_reason === "max_tokens"`.
2. `AgentSessionManager.completeSession` now captures the last assistant
   message's `error` field per turn (durable across the one-behind buffer
   discard), and — when `isTruncatedTurn` fires, there's no pending work, and
   the session's tracker is Linear — posts a fixed warning as the LAST
   activity instead of reclassifying the turn to `Error`. Status intentionally
   stays `Complete` so a warm/held-open runner is never reaped by mistake.
3. `EdgeWorker.reconcileTerminatedRunner` (already handles out-of-band death →
   `Error` reconciliation from a prior PR) now also posts a visible
   `createErrorActivity` notice — gated on the pre-transition status not
   already being terminal and the tracker being Linear — before flipping the
   session to `Error`. `markSessionResuming` flips status back to `Active` on
   the next prompt, so the gate naturally re-arms for a later failure.

The observable signals: the exact warning strings in the activity timeline,
absence of those strings on a clean run, and the internal
`status <old> → <new>` log lines that prove `AgentSessionManager`'s real
session record (not just the CLI issue-tracker's separate bookkeeping)
transitioned.

## Setup

```bash
cd apps/f1
./f1 init-test-repo --path <scratch>/f1-truncation-drive/repo
CYRUS_PORT=3670 CYRUS_REPO_PATH=<scratch>/f1-truncation-drive/repo \
  bun run server.ts > <scratch>/f1-truncation-drive/server.log 2>&1 &
```

Repo config (`server.ts`, unmodified): `teamKeys: ["PRIMARY"]`. F1's default
CLI-mode team key is `DEF`, so every issue here triggers the documented
repository-selection elicitation — resolved via `./f1 prompt-session
--session-id <id> --message "F1 Test Repository"` (known F1 gotcha, repeated
from the 2026-07-02 and 2026-07-05 drives). No `server.ts` edits were made.

## S1 — regression guard: normal issue completes cleanly, no spurious note

Small, well-scoped issue (`DEF-1`): add a `getAvailableTokens()` accessor
method to the existing rate limiter — deliberately trivial so the turn
finishes in one shot without hitting any output-token ceiling.

1. `create-issue` + `start-session` → elicitation → `prompt-session` resolves
   the repo selection; runner initializes:
   ```
   [event:session_started] {"workingDirectory":".../worktrees/DEF-1","model":"sonnet","fallbackModel":"haiku"}
   ```
2. Session works through reading the code, editing it, running the repo's
   typecheck, committing, and reporting no remote is configured (expected —
   disposable local-only test repo). Ends with:
   ```
   [event:message_emitted] {"messageType":"result","claudeSessionId":"..."}
   Result message emitted to Linear (activity activity-53)
   Session completed (subtype: success)
   [event:session_completed] {"messageCount":149,"claudeSessionId":"..."}
   ```
3. Confirmed the truncation note never fired:
   ```
   $ grep -c "Posted max_output_tokens truncation note" server.log
   0
   ```
4. Confirmed the final activity is a genuine non-error response, not surfaced
   through the new truncation path: `completeSession` only logs "Session
   completed (subtype: success)" — the else-branch of `isErrorResult` — which
   is only reachable when `resultMessage.is_error` is falsy, which in turn is
   the only condition under which `addResultEntry`'s `entry.metadata.isError`
   is falsy and `syncEntryToActivitySink`'s switch-case resolves the content
   to `type: "response"` (not `"error"`). Combined with the truncation-note
   log being absent, the last activity is the plain "Finished" response, not
   the warning.

**Result: PASS.** Clean turn completes as `Complete` with an intact final
response activity, and the new truncation-detection code path does not fire
on a normal, non-truncated turn.

### F1-harness quirk found while verifying (not a Feature A bug)

`./f1 view-session`'s `viewSession` RPC handler fetches per-session activities
via `issueTracker.listAgentActivities(sessionId)` with **no options** — which
defaults to `{ limit: 50, offset: 0 }` inside the CLI issue-tracker stub — and
only paginates *that* already-capped array afterward, despite a code comment
claiming it fetches "ALL activities... (no limit yet)". Once a session's raw
activity count (which includes ephemeral in-progress markers later superseded
by a final version, so it runs higher than the visible count) crosses 50, the
tail silently drops — including, in this drive, the final response activity
after a longer turn. This is purely a limitation of the F1 CLI test-harness
stub's RPC handler (real Linear/GitHub/GitLab activity listing is unaffected);
it doesn't reflect on `AgentSessionManager` or `EdgeWorker` correctness. I
worked around it here by cross-checking `server.log` (see S1 step 2 above and
S2 below) instead of relying solely on `view-session` output for anything
past ~30-40 activities in a session. Filing this as a known F1 gotcha for
future drives; no production code was touched to work around it.

## S2 — out-of-band termination + recovery (core validation)

New issue (`DEF-2`, `session-2`), same elicitation/resolution pattern as S1.
Once the runner initialized, found the actual OS child running the bundled
`claude` binary as a direct child of the F1 server process (`ps --ppid
<server-pid>`), then killed it out of band — **not** via `./f1 stop-session`
— to simulate a crash:

```bash
kill -KILL <child-pid>
```

Confirmed the process was gone (`ps -p <child-pid>` → exit code 1, no
matching row) within ~1s.

**Server log shows the reconcile chain, unprompted** (no `stop-session` was
ever called for this session):

```
error: Claude Code process terminated by signal SIGKILL
[EdgeWorker] Unhandled claude error: ...
[EdgeWorker] Runner for session session-2 terminated out of band (error); reconciling to Error
```

**The visible retry notice** — confirmed via the RPC's raw activity list
(needed because of the F1-harness 50-activity cap noted above, though this
session stayed under it) — shows up as the very next activity after the
in-flight tool call, exactly matching the fix's literal string:

```
{
  "id": "activity-62",
  "type": "error",
  "content": "⚠️ This session stopped unexpectedly and was reset (reason: error). Re-prompt to retry.",
  "createdAt": ...
}
```

Its timestamp lines up with the "reconciling to Error" log line to the
millisecond, confirming it's posted as part of the same reconcile call, before
`markSessionStopped` flips the internal status.

**Re-prompted the same session ID** (no new issue, no new session):

```bash
./f1 prompt-session --session-id session-2 --message "Please continue and add the requested resetCounter helper now."
```

Log:

```
[AgentSessionManager] Marking session as resuming: status error → active
[resumeAgentSession] needsNewSession=false, resumeSessionId=<claude-session-id>
[event:session_resumed] {"resumeSessionId":"<claude-session-id>","workingDirectory":".../worktrees/DEF-2","model":"sonnet","fallbackModel":"haiku"}
[event:claude_query_options] {"cqo.model":"sonnet",...,"cqo.resumeSessionId":"<claude-session-id>"}
```

The `status error → active` line is the internal proof: `AgentSessionManager`'s
own session record really had flipped to `Error` after the kill (not just the
CLI issue-tracker's separate bookkeeping, which — per the known F1-CLI-mode
observability quirk documented in the 2026-07-05 drive — keeps showing
`Status: active` throughout regardless).

**A brand-new OS process spawned** for the resumed turn — confirmed via
`ps --ppid <server-pid>`, a distinct PID from the one killed above — while the
F1 server process itself (checked via `ps -p <server-pid>` and `./f1 status`
uptime) never restarted throughout the whole sequence.

The session then continued working normally and reached a clean completion
on its own:

```
[AgentSessionManager] Session completed (subtype: success)
[event:session_completed] {"messageCount":125,"claudeSessionId":"<claude-session-id>"}
```

with the full activity timeline showing, in order: the initial work, the
error notice (`activity-62`), the re-prompt (`activity-63`), and a fresh
sequence of exploration/edit/verify/commit activity through to completion —
confirming the retry genuinely picked the work back up rather than starting
over blind.

**Result: PASS.** Out-of-band death reconciles to `Error` with a visible,
correctly-worded timeline notice; the very next prompt on the same session ID
spawns a fresh OS process, resumes the underlying conversation, and the
session goes on to complete normally — all without any daemon/process
restart.

## S3 — max_output_tokens truncation via a real prompt: SKIPPED (no practical knob)

Searched `packages/claude-runner` for any output-token-cap option surfaced to
the SDK (`maxTokens`, `max_output_tokens`, `maxOutputTokens`, etc.) and found
none — the only per-session numeric knob is `maxTurns` (a turn-COUNT limit,
confirmed unrelated: it's plumbed straight through as `maxTurns` in the CLI
args, nothing to do with output tokens). Also checked the installed
`@anthropic-ai/claude-agent-sdk` type definitions directly: the only
`maxOutputTokens`/`maxTokens` fields that exist are read-only usage/context
reporting shapes (`ModelUsage.maxOutputTokens`,
`SDKControlGetContextUsageResponse.maxTokens`) — not configurable inputs.
There is no way to force a real per-turn output-token ceiling from F1 or from
runner config today, and reliably forcing an actual model response long
enough to hit whatever the live ceiling is would be non-deterministic and
slow even if a knob existed.

Per instructions, this was not faked. It is exercised directly, deterministically,
and against the real `completeSession` code path (not a fully-mocked
double) by the accompanying unit test suite:

```
packages/edge-worker/test/AgentSessionManager.truncation.test.ts
```

This test builds a real `AgentSessionManager`, drives it through
`handleClaudeMessage` with a synthetic `error: "max_output_tokens"` assistant
message followed by a `subtype:"success"` result, and asserts against the
manager's own public session/activity-sink surface (not internal mocks of
`completeSession` itself) that: status stays `Complete`; the truncation note
is posted as the last activity; the capture is cleared so a later clean turn
posts no stray note; the note is Linear-only; and pending work still wins the
last-activity slot over the truncation note. Ran it live as part of this
drive alongside the two other new test files on the branch:

```
$ npx vitest run test/AgentSessionManager.truncation.test.ts test/sessionStatus.test.ts \
    test/isTruncatedTurn.test.ts test/EdgeWorker.reconcile-terminated-runner.test.ts

 Test Files  4 passed (4)
      Tests  23 passed (23)
```

**Result: SKIPPED (by design, per instructions) — coverage confirmed via the real unit-test seam above, all 23 tests passing.**

## Verification Results

### Issue-Tracker
- [x] Issues created (`DEF-1`, `DEF-2`), IDs returned
- [x] Repo-selection elicitation posted + resolved via `prompt-session` (team
      `DEF` ≠ repo `teamKeys: ["PRIMARY"]`, per the known F1 gotcha)

### EdgeWorker / Runner
- [x] Clean turn (S1): status `Complete`, no truncation note, intact final
      response activity
- [x] Out-of-band kill (S2): `onTerminated`/thrown-error path →
      `reconcileTerminatedRunner` posts the "stopped unexpectedly ... re-prompt
      to retry" notice BEFORE flipping status to `Error`
- [x] Re-ping on the same session ID after reconciliation spawns a new OS
      process and resumes the underlying conversation to a clean completion
- [x] No daemon/process restart at any point (stable server PID throughout)
- [ ] S3 (real max_output_tokens induction via F1) — not applicable; no
      practical knob exists. Covered instead by a real-seam unit test (23/23
      passing).

### Renderer / events
- [x] `[event:session_started]`, `[event:session_stopped]`/reconcile log,
      `[event:session_resumed]`, `[event:claude_query_options]`,
      `[event:session_completed]` all present and well-formed
- [x] The two new literal warning strings appear verbatim and in the right
      place (last activity for the truncation note; immediately after the
      kill, before the re-prompt, for the termination notice)

## Final Retrospective

- Both must-pass scenarios (S1 regression guard, S2 out-of-band
  termination/recovery) passed cleanly against real OS processes and real
  `AgentSessionManager`/`EdgeWorker` logs — not mocks.
- S3 has no practical live-F1 induction path today (confirmed by reading both
  `claude-runner`'s option surface and the installed SDK's type definitions);
  skipping it live and relying on the existing real-seam unit test was the
  right call rather than fabricating a fake truncation.
- Genuine surprise: F1's own CLI test-harness (`CLIRPCServer.handleViewSession`
  → `CLIIssueTrackerService.listAgentActivities`) silently caps a session's
  raw activity fetch at 50 before pagination, contradicting its own "fetch
  ALL activities" comment. This clipped the tail of S1's longer session when
  viewed through `./f1 view-session`, even though the server log confirmed
  the real activity had posted correctly. Not a Feature A defect — a
  test-harness-only limitation worth fixing separately, and worth remembering
  for future drives on longer sessions (cross-check `server.log` rather than
  trusting `view-session` alone past ~40-50 activities).
- No `apps/f1/server.ts` edits were made or needed for this drive.
