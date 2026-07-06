# Test Drive: characterizing real SDK message-stream gaps for a stall watchdog

**Date**: 2026-07-06
**Goal**: OBSERVATION drive (not feature validation) to characterize real inter-message
gaps in the Claude Agent SDK's message stream, ahead of designing a stall watchdog that
aborts a turn after N ms of silence (with a longer budget while a tool is in flight).
**Test Repo**: `<scratch>/f1-stall-watchdog-drive/repo` (rate-limiter scaffold via
`./f1 init-test-repo`, disposable)
**Branch**: `feat/stall-watchdog`

## Build step

Per protocol, ran the build first:

```
env -u CLAUDE_CODE_ENABLE_TELEMETRY pnpm build
```

All 17 workspace packages built clean.

## Setup notes

Three separate F1 server instances were used (one per observation, ports 3601/3602/3603),
each pointed at the same disposable test repo. Repo config (`server.ts`, unmodified):
`teamKeys: ["PRIMARY"]`. F1's default CLI-mode team key is `DEF`, so every issue here
triggers the documented repository-selection elicitation — resolved via
`./f1 prompt-session --session-id <id> --message "F1 Test Repository"` (known F1 gotcha,
repeated from the 2026-07-02 and 2026-07-06 drives). No `server.ts` edits were made except
setting `CYRUS_ENABLE_WARM_SESSIONS=1` for Observation 2.

The signal used throughout is the `[event:message_emitted] {"messageType":...}` line the
runner (`ClaudeRunner.ts`) logs for every SDK message it receives, immediately in-loop, with
an ISO-8601 millisecond timestamp prefix from the shared logger. Gaps below are computed
directly from these timestamps (cross-checked against the full per-session JSONL transcript
under the server's temp home, which additionally exposes `messageType`/`subtype` and
tool_use/tool_result/thinking content).

---

## Observation 1 — silent long tool (highest priority)

**Setup**: issue instructing the agent to run a deliberately silent, long, foreground tool
call via Bash, then report done.

**First attempt (informative side-finding, not the answer)**: asked for a bare `sleep 90`.
Claude Code's own Bash-tool guard blocked it outright before it ever became a blocking
tool call:

```
assistant tool_use Bash {"command": "sleep 90", ...}
user      tool_result <tool_use_error>Blocked: standalone sleep 90. To wait for a
          condition, use Monitor with an until-loop... To wait for a command you
          started, use run_in_background
assistant tool_use Bash {"command": "sleep 90", ..., "run_in_background": true}
```

The model was forced into `run_in_background: true`, which is a completely different
code path (session held open for pending background work, not a blocking tool_use →
tool_result gap). This is a built-in Claude Code behavior, not something Cyrus configures.
**Design note**: naive "just sleep" tool calls will not exercise the blocking path at all —
they get converted into a background task. To get a genuinely blocking, silent, long tool
call we had to route around the guard.

**Second attempt (the answer)**: new issue asking the agent to run
`python3 -c "import time; time.sleep(90)"` as a single synchronous, foreground Bash call,
explicitly instructed not to use `run_in_background`, not to poll, and not to use
Monitor/until-loops. The model complied with a single blocking call.

Raw log lines (server log, `[EdgeWorker]` component, session context omitted where
redundant):

```
2026-07-06T07:24:06.495Z [event:message_emitted] {"messageType":"assistant", ...}   ← tool_use: Bash "python3 -c \"...time.sleep(90)\""
2026-07-06T07:24:06.550Z [event:message_emitted] {"messageType":"rate_limit_event", ...}
2026-07-06T07:24:09.824Z [event:message_emitted] {"messageType":"system", ...}      ← subtype "task_started" (internal tool-progress marker)
2026-07-06T07:25:36.875Z [event:message_emitted] {"messageType":"system", ...}      ← subtype "task_notification"
2026-07-06T07:25:37.032Z [event:message_emitted] {"messageType":"user", ...}        ← tool_result: "(Bash completed with no output)"
2026-07-06T07:25:38.399Z [event:message_emitted] {"messageType":"assistant", ...}   ← text: "The 90-second sleep has completed."
2026-07-06T07:25:38.505Z [event:message_emitted] {"messageType":"result", ...}
```

**Gap**: from `task_started` (07:24:09.824Z) to `task_notification` (07:25:36.875Z) is
**87.051 seconds of complete silence** — zero intervening `message_emitted` lines of any
kind. The `task_notification` arrives essentially back-to-back with the `tool_result`
(0.157s later), i.e. it is the signal that immediately precedes tool completion, not a
progress heartbeat during the wait.

**ANSWER**: During a genuinely blocking, silent, long tool call, the SDK is **fully silent**
between tool dispatch and tool completion — one internal `system`/`task_started` marker
fires a few seconds after `tool_use` (this is effectively "tool now in flight," not a
recurring heartbeat), and then literally nothing else arrives until the tool result itself.
A silent long tool relies **entirely** on the tool-in-flight budget; there is no secondary
signal a watchdog could use to distinguish "still running, healthy" from "hung" during that
window.

---

## Observation 2 — between-turns on a warm runner

**Setup**: restarted the F1 server with `CYRUS_ENABLE_WARM_SESSIONS=1` (in addition to
`CYRUS_PORT`/`CYRUS_REPO_PATH`). Ran a small, well-scoped issue (add an accessor method) to
completion, then waited without sending another prompt.

Raw log lines around and after completion:

```
2026-07-06T07:28:58.285Z [event:message_emitted] {"messageType":"assistant", ...}
2026-07-06T07:28:58.405Z [event:message_emitted] {"messageType":"result", ...}
2026-07-06T07:28:58.409Z  Result message emitted to Linear (activity activity-41)
2026-07-06T07:28:58.409Z  Session completed (subtype: success)
2026-07-06T07:28:58.410Z [event:message_emitted] {"messageType":"system", ...}
<... no further log lines for 165+ seconds ...>
```

Two things worth calling out:

1. `[event:session_completed]` (the event `ClaudeRunner` logs once the `for await` message
   loop exits) **never fires** during this idle window. Reading `ClaudeRunner.ts`: on a
   successful `result`, the loop only calls `streamingPrompt.complete()` — which is what
   lets the loop exit and `session_completed` fire — when `!this.keepSessionWarm`. With
   warm sessions enabled, `keepSessionWarm` is `true`, so the loop stays parked on
   `for await` waiting for the *next* SDK message on the same still-open stream, which
   won't arrive until a new prompt is queued.
2. Confirmed via `ps` that the underlying Claude CLI subprocess remained alive and
   unchanged (same process, no restart) throughout the idle window — this is a genuinely
   idle-but-alive warm runner, not a session that silently died.

Checked twice, at t+106s and again at t+165s after the last log line — zero new log lines
either time. No `stream_event`, no `rate_limit_event`, no `auth_status`, no keepalive, no
message of any kind arrived on the idle warm runner.

**ANSWER**: Nothing arrives between turns on a warm runner. The gap is not merely "long" —
it is **unbounded silence with no natural reset signal**, because the underlying process is
deliberately being kept alive and parked, and `session_completed` (which would normally mark
"turn is over") does not fire in this configuration until the *next* turn's `result` closes
it out.

---

## Observation 3 — thinking / reasoning phase (best-effort)

**Setup**: issue asking the agent to carefully analyze the tradeoffs of three
rate-limiting algorithms (memory overhead, burst tolerance, concurrency accuracy,
implementation complexity, ≥3 edge cases each) before writing any code or a short summary.
This did induce genuinely long reasoning; results below are from the full transcript
(125 messages total).

**First message after turn start**: fast — the first `system`/`hook_started` events
appear within ~1ms of prompt dispatch, and the first assistant text appears at
07:32:52.667Z, about **4.56 seconds** after the resolving prompt was sent (07:32:48.107Z).
So there was **no long silent gap before the first message** — incremental
`system`/`thinking_tokens` events streamed in small sub-second-to-few-second bursts almost
immediately.

**During generation**, most gaps between consecutive messages were small (0.001s–0.5s
during active `thinking_tokens` streaming bursts, occasionally 2–7s between bursts). But
two much larger silent gaps appeared, both with the same shape — right after an `assistant`
message carrying a large **aggregated** thinking block (as opposed to the small incremental
`thinking_tokens` chunks), and right before the next `assistant` message with visible text:

```
2026-07-06T07:34:01.608Z  assistant  thinking_len=5441      (aggregated thinking block)
2026-07-06T07:34:50.165Z  assistant  text="Now I have full context on the codebase..."
                            ← 48.557s of complete silence, zero intervening messages

2026-07-06T07:34:55.819Z  assistant  thinking_len=206        (aggregated thinking block)
2026-07-06T07:35:17.418Z  assistant  text="## Summary\n\nCompleted a thorough tradeoff..."
                            ← 21.599s of complete silence, zero intervening messages
2026-07-06T07:35:17.552Z  result     success
```

**ANSWER**: The first message of a turn arrives quickly (no long silent gap at turn start).
But `thinking_tokens` incremental streaming does **not** cover the entire
reasoning/generation window — it stops before the corresponding text is ready, and the SDK
bridge can go fully silent for **tens of seconds** (48.6s max observed, 21.6s a second time
in the same turn) between the aggregated-thinking assistant message and the next assistant
message, with no tool in flight and no streaming signal during that window. This happened
twice in one turn (mid-analysis and again at final-summary), so it looks like a recurring
shape rather than a one-off.

---

## Design implications

**(a) Is a 10-minute (600s) model-idle budget safe given what we saw?**
Yes, on the evidence gathered here. The largest silent gap observed during pure model
generation (no tool in flight) was 48.6 seconds — over 12x margin under 600s. Recommend
keeping 10 minutes, but treat this as one data point from one moderately-deep reasoning
prompt, not an exhaustive bound; harder tasks or different models could plausibly push
single silent-generation gaps higher, though nothing here suggests they'd approach minutes.

**(b) Is a 30-minute (1800s) tool-in-flight budget reasonable for a silent tool?**
Yes. Observation 1 showed a genuinely blocking, silent 90-second tool call producing
literally zero intervening `message_emitted` lines beyond a single "task in flight" marker.
Since the SDK gives no secondary progress signal at all during a blocking tool call, the
tool-in-flight timeout is the *entire* safety net for this scenario — there is nothing else
to fall back on. 30 minutes gives ~20x margin over the 87s case observed here and is
reasonable for realistic long-running commands (builds, test suites, large clones/installs);
just be aware it is a hard trust boundary, not a "reset on partial progress" mechanism.

**(c) Is an explicit turn-active gate (arm on prompt, disarm on result, don't re-arm
between turns) necessary?**
Yes — Observation 2 confirms this directly and it is the most load-bearing finding of the
three. Nothing arrives between turns on a warm runner: we measured 165+ seconds of total
silence with zero messages of any kind, and confirmed the underlying subprocess was alive
and unchanged throughout (not a crash). Critically, `session_completed` — the event that
would otherwise look like a clean "turn is over" signal — does **not** fire in the warm-keep
configuration until the *next* turn's `result` closes the loop. A watchdog that arms once and
resets only "on any message" would, on a warm runner, see a long idle window after `result`
with no natural reset point, and would eventually cross even a 10-minute idle threshold on a
perfectly healthy runner that is simply waiting for the next human/system prompt. The gate
must be explicit and tied to turn boundaries (arm on prompt dispatch, disarm specifically on
the `result` message, not on "any message"), not inferred from message activity.

## CONTRADICTION CHECK

None of the three observations contradict the 10-minute idle / 30-minute tool-in-flight
defaults as currently proposed. The one finding that *would* break a naive implementation is
not about the timeout values themselves but about scope: without the explicit turn-active
gate from (c), the 10-minute idle budget would be applied across warm-runner between-turn
silence (which is unbounded and by-design silent) and could fire false positives on
healthy, idle warm sessions.

## Final Retrospective

- The bare-`sleep`-gets-guarded-into-`run_in_background` behavior was an unplanned but
  useful discovery — it means the naive way of inducing "long silent tool" in a test drive
  doesn't exercise the code path a stall watchdog cares about, and real long-silent tools
  (compiles, test runs, network fetches) will behave like the `python3 -c "time.sleep(90)"`
  case, not the bare `sleep` case.
- F1 usage gotcha (repeated from prior drives): an issue whose team key doesn't match a
  repo's `teamKeys` triggers a repository-selection elicitation; the runner does not
  initialize until a `prompt-session` call resolves it with the repo's display name.
- All three F1 server instances, their sessions, and the underlying Claude CLI subprocesses
  were stopped/killed at the end of each observation; no server was left running.
