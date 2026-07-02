# Test Drive: fallback-model chain reaches the SDK

**Date**: 2026-07-02
**Goal**: Verify an ordered `fallbackModel` chain configured in Cyrus actually reaches the Claude SDK as the comma-joined `--fallback-model` value.
**Test Repo**: `/tmp/f1-fallback-drive-*` (rate-limiter scaffold, disposable)
**Branch**: `tenfourty-deploy` (feature + precedence fix)

## What this exercises

The feature lets `fallbackModel` (per-repo) and `claudeDefaultFallbackModel` (global)
accept an ordered list. cyrus's job is to hand the whole chain to the SDK as the
comma-separated form the Claude CLI's `--fallback-model` splits and tries in order.
The observable is the runner's `[event:session_started]` and `[event:claude_query_options]`
(`cqo.fallbackModel`) — emitted at query-build time, so capturable regardless of
whether the model call itself succeeds.

Config under test (F1 `server.ts`, temporary): `claudeDefaultModel: "sonnet"`,
`claudeDefaultFallbackModel: ["haiku", "opus"]`.

## Verification Results

### Issue-Tracker
- [x] Issue created (`DEF-1`), ID returned
- [x] Repo-selection elicitation posted (issue team `DEF` ≠ repo `teamKeys`), runner
      correctly deferred until a prompt resolved the selection

### EdgeWorker / Runner
- [x] Session started, worktree created, runner initialized after prompt
- [x] Query-build events emitted with the resolved fallback

### Renderer / events
- [x] `[event:session_started]` and `[event:claude_query_options]` present and well-formed

## Key finding (first run — BUG) → fix → re-run (PASS)

**First run** (feature only): the runner received a single model, not the chain.

```
[event:session_started]        {"model":"sonnet","fallbackModel":"haiku"}
[event:claude_query_options]   "cqo.fallbackModel":"haiku"
```

Root cause: `RunnerSelectionService.determineRunnerSelection` ALWAYS derives a
`fallbackModelOverride` from the model (`inferFallbackModel`: sonnet→haiku,
unknown→sonnet), and `RunnerConfigBuilder` ranked that inferred override ABOVE
`repository.fallbackModel` and `claudeDefaultFallbackModel`. So the configured
chain never reached the SDK for the Claude runner — including the reporter's
GLM-5.2 primary (whose inferred fallback is `sonnet`). Unit tests passed; the
shadowing only showed at the config→runner integration seam. Fix: explicit
config now outranks the inferred default (repo > global > inferred > hardcoded),
via new `getConfiguredFallbackModelForRunner`.

**Re-run** (after fix, same config):

```
[event:session_started]        {"model":"sonnet","fallbackModel":"haiku,opus"}
[event:claude_query_options]   "cqo.fallbackModel":"haiku,opus"
```

The joined chain `haiku,opus` reaches the SDK. The SDK bridge emits it as a
single `--fallback-model haiku,opus` arg, which the Claude CLI splits and tries
in order. ✅

## Scope note

This drive proves the chain reaches the SDK (cyrus's responsibility). The actual
429-triggered failover primary→next is the Claude CLI/SDK's `--fallback-model`
behavior, not cyrus code; it is confirmed live on the Bifrost gateway (or via a
mock Anthropic endpoint) rather than here.

## Final Retrospective

- The drive did its job: it caught a real precedence bug that unit tests (which
  mock the selector) did not surface. Fixed on the feature branch, cherry-picked,
  re-verified here.
- F1 usage gotcha: an issue whose team key doesn't match a repo's `teamKeys`
  triggers a repository-selection elicitation; the runner does not initialize
  until an `agentSessionPrompted` webhook (a `prompt-session` call) resolves it.
```
