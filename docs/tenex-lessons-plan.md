# Tenex Lessons Plan

This plan treats Tenex as a reference for operating discipline, not feature scope.

The goal is to keep `openteam` a focused Nostr-git/OpenCode orchestration runtime while adopting reliability patterns that make the narrow runtime hard to misuse.

## Boundary

`openteam` should stay focused on:

- resolving Nostr-git repository targets
- creating and reusing orchestrator-owned repo contexts
- launching focused OpenCode workers
- managing browser, signer, and runtime isolation
- tracking runs, logs, leases, stale state, and cleanup
- routing operator control only through the orchestrator

Do not turn `openteam` into a general agent platform.

Avoid importing these Tenex-scale concepts for now:

- broad LLM provider abstraction
- RAG, search, and indexing
- Telegram, APNs, or other extra transports
- dynamic agent install/update system
- full conversation store
- prompt-history and context-management machinery
- scheduler
- MCP server manager
- broad daemon routing for arbitrary project types
- generic tool registry

## Current Lesson

The stale-run issue showed the main reliability gap:

- detection existed in `runs diagnose`
- default status surfaces still reported raw `running`
- the orchestrator could therefore report ghost workers unless it remembered to diagnose

The rule going forward:

- operator-facing status commands must report effective state derived from live signals
- raw stored state should be available only as diagnostic detail
- runtime invariants should be tested, not left as prompt discipline

## Phase 1: Extract CLI Logic

Problem:

- `src/cli.ts` currently contains command parsing, run diagnosis, browser inspection, repo publish commands, profile sync, relay sync, console prompt generation, and status rendering.
- This makes it easy for business logic to accumulate in the command layer.

Target structure:

- `src/commands/runs.ts`: list, show, diagnose, cleanup, stop
- `src/commands/browser.ts`: browser status and attach
- `src/commands/repo-publish.ts`: CLI wrappers around repo publish helpers
- `src/commands/status.ts`: effective operator status summary
- `src/commands/profile.ts`: relay/profile/token sync commands
- `src/commands/console.ts`: operator console prompt
- `src/cli.ts`: command routing only

Acceptance checks:

- `src/cli.ts` has no run-state business logic
- command outputs remain backward-compatible except where intentionally improved
- `openteam status`, `runs list`, `runs show`, `browser status`, and `runs cleanup-stale --dry-run` keep working

## Phase 2: Centralize Event Constants

Problem:

- Nostr kind numbers and protocol names are spread across modules.

Add:

```text
src/events.ts
```

Include:

- `KIND_REPO_ANNOUNCEMENT = 30617`
- `KIND_DM = 4444`
- `KIND_OUTBOX_RELAYS = 10002`
- `KIND_DM_RELAYS = 10050`
- repo event kinds for issues, comments, labels, statuses, PRs, and PR updates
- tag namespace constants such as `org.nostr.git.role`

Acceptance checks:

- no duplicated magic event kind constants in `src/repo.ts`, `src/nostr.ts`, or `src/repo-publish.ts`
- docs refer to named constants where useful
- tests continue to assert exact numeric values

## Phase 3: Lightweight Config Validation

Problem:

- config loading merges and interpolates values but does not consistently explain human configuration errors before runtime.

Add:

```text
src/config-validate.ts
```

Start with manual validation, not a large schema system.

High-value checks:

- orchestrator identity has `identity.sec` when DM control or fork announcements are needed
- worker identities have `identity.sec` when bunker, profile sync, or repo publishing is needed
- relay URLs are syntactically valid and normalized
- relay buckets are not accidentally mixed for DM, signer, app-data, and repo workflow purposes
- `nostr_git.graspServers` entries are relay-like URLs
- GitHub/GitLab providers with configured hosts have token env vars resolved
- GRASP fallback is available when no provider tokens are configured
- `browser.mcp.command` exists before web-mode launch
- repo config paths resolve to usable paths where local paths are still configured

Call validation from:

- `doctor`
- `launch`
- `serve`
- `relay sync`
- `profile sync`
- `repo publish`

Acceptance checks:

- validation returns actionable messages, not stack traces
- warnings do not block safe read-only commands unless the command requires the missing capability
- tests cover missing researcher/builder/qa/orchestrator identity secrets by capability

## Phase 4: Runtime Invariants As Tests

Problem:

- dangerous behaviors have been found through live runs instead of tests.

Add targeted tests for invariants:

- same repo serializes unless `parallel` is explicit
- leased contexts are released after success, failure, interruption, and stale cleanup
- stale cleanup does not delete checkouts
- cleanup does not release a context leased by a different newer run
- outside-owned repo resolves to an orchestrator-owned fork before worker handoff
- workers cannot receive operator DM control
- provision mode blocks worker-control commands
- web status does not report a dead dev URL as live
- `runs list` and `runs show` report effective stale state when live signals disagree with stored state
- relay bucket selection keeps DM, signer, app-data, and repo relays separated

Acceptance checks:

- tests fail if raw `running` is exposed as operational truth for a stale run
- tests do not require network access
- tests avoid launching OpenCode

## Phase 5: Small Supervision, Not Agent Governance

Problem:

- LLM prompt discipline should not be responsible for runtime correctness.

Add deterministic runtime checks around existing execution points:

- before launch: target resolved, context leased, run record created, checkout exists
- before worker handoff: provisioning phase is terminal and did not call worker-control commands
- before web worker success: dev URL was reachable at least once and final browser status is not stale
- before repo publish: `.openteam/repo-context.json` exists and publish scope is known
- after failure: run phase, log paths, blocker text, cleanup result, and lease state are recorded
- after cleanup: context lease is released only if it still matches the run

Acceptance checks:

- failures point to the exact failed invariant
- run records contain enough evidence for `runs diagnose`
- no generalized LLM supervision or heuristic policy engine is added

## Phase 6: Operational Status First

Problem:

- operator commands must be reliable enough that humans do not need to read runtime JSON manually.

Improve and keep stable:

- `openteam status`
- `openteam runs list`
- `openteam runs show`
- `openteam runs diagnose`
- `openteam runs cleanup-stale --dry-run`
- `openteam worker list`
- `openteam repo policy`
- `openteam doctor`

Acceptance checks:

- `openteam status` says how many workers are live, how many recent runs are stale, and whether stale leases exist
- `runs list` and `runs show` expose `state`, `storedState`, `staleReasons`, and live-signal summary
- `doctor` reports config readiness by capability
- cleanup commands are dry-run-first and never delete checkouts

## Phase 7: Optional Runtime Status File

Only after phases 1-6, consider a tiny status file:

```text
runtime/status.json
```

Scope:

- orchestrator process PID if known
- live managed workers
- recent run counts by effective state
- stale lease count
- last cleanup time

Do not add a Tenex-style daemon subsystem unless the existing `status` and run records prove insufficient.

## Sequence

Recommended order:

1. Extract `runs` and `browser` command modules from `src/cli.ts`.
2. Add `src/events.ts` and replace magic kind constants.
3. Add lightweight config validation and wire it into `doctor` first.
4. Add invariant tests for stale state, provision guard, and lease cleanup.
5. Add `docs/invariants.md`.
6. Expand `doctor` and `status` to expose capability-specific readiness.
7. Reassess whether a tiny runtime status file is still needed.

## Principle

The clean version of `openteam` is not a smaller Tenex.

It is a focused Nostr-git/OpenCode orchestration runtime with strong invariants, clear failure modes, and enough structure that complexity cannot leak into every file.
