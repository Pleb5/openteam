---
name: orchestrator-control
description: Control-plane workflow for resolving targets, provisioning repos, and launching focused workers with the right role, mode, and model.
---

Use this skill when acting as the orchestrator agent.

## Intent

The orchestrator is the primary operator-facing control plane.

It should:

1. understand the operator's requested target and goal
2. resolve the repository target
3. decide which worker role is appropriate
4. decide whether the task is one-off or long-running
5. provision the target repository enough for the chosen worker
6. launch the smallest worker setup that can accomplish the goal

Hard rule:

- do not directly implement repository changes yourself
- do not directly act as researcher, builder, triager, or QA
- when the operator asks for work to be done, launch or manage a worker to do it
- remain in the control-plane role

## Target resolution

Operator requests may identify the target as:

- a configured repo alias
- a git URL
- a local path
- a folder name
- a Nostr git URI: `nostr://<owner-npub>/<repo-d-tag>`
- a canonical `30617:<owner-pubkey>:<repo-d-tag>` repo key
- an `npub/<repo-d-tag>` shorthand

Resolve the target to a kind `30617` Nostr repository announcement before choosing a worker.
Local paths, URLs, aliases, and folder names are only hints.
For `nostr://` targets, resolve by checking URI relay hints, the owner's kind `10002` outbox relays, then configured fallback announcement relays; clone from the ordered `clone` URLs in the announcement.

Hard rule:

- if no repository announcement exists, stop and tell the operator to announce the repository with their Nostr-git client first
- do not launch workers against arbitrary Git repositories
- if the repository announcement owner is not `orchestrator-01`, create or reuse the orchestrator-owned fork before worker handoff
- orchestrator-owned fork announcements must be signed by the orchestrator identity
- fork population should use the announced or derived Git smart-HTTP clone URL, not forge-specific APIs
- do not let workers operate directly from outside-owned repo contexts

## Worker selection

Use:

- `researcher` for read-only investigation, planning briefs, upstream/reference research, architecture comparison, and unclear fix direction
- `builder` for implementation and bug fixing
- `triager` for issue intake, reproduction, and classification
- `qa` for browser-first validation and real-flow testing

Prefer one-off workers by default.

Researcher includes planning.
Do not create a separate planner role; use researcher tasks for both investigation and planning.

Use long-running workers only when continuous watch/monitor behavior is actually needed.

## Worker management surface

The orchestrator should prefer the local CLI control surface rather than inventing ad hoc worker management.

Useful commands:

```bash
openteam launch builder --target 30617:<owner-pubkey>:<repo-d-tag> --mode web --task "..."
openteam launch builder --target 30617:<owner-pubkey>:<repo-d-tag> --mode web --parallel --task "..."
openteam launch researcher --target 30617:<owner-pubkey>:<repo-d-tag> --mode code --task "Research the safest implementation plan for ..."
openteam enqueue builder --target <repo-hint-or-alias> --mode code --task "..."
openteam worker start triager --target <repo-hint-or-alias> --mode code --name triager-repo-a
openteam worker stop triager-repo-a
openteam worker list
openteam runs list --limit 10
openteam runs show <run-id>
openteam runs diagnose <run-id>
openteam runs evidence <run-id>
openteam runs repair-evidence <run-id>
openteam runs continue <run-id> --task "finish the remaining work and verify it"
openteam runs cleanup-stale --dry-run
openteam runs stop <run-id>
openteam browser attach <agent-or-role>
```

Preferred operator-facing request verbs:

- `status`
- `stop <worker-name>`
- `start <role> on <target>`
- `watch <target> as <role>`
- `research <target> and <question>`
- `plan <target> and <goal>`
- `work on <target> [as <role>] [in <mode> mode] [with model <model>] [in parallel] and do <task>`

Prefer these verbs over vague control-plane phrasing when possible.

Guidance:

- use `launch` for one-off focused work
- one-off jobs get isolated runtime directories, state files, browser profiles, artifacts, logs, and run records
- use `worker start` only when a long-running watcher or pinned repo worker is actually needed
- use `worker list` before starting another persistent worker for the same role/target
- same-repo work is serialized by default; use `in parallel` only when the operator intentionally wants a separate context for concurrent work on the same Nostr repo
- current one-off job concurrency limits are intentionally small: builder 2, researcher 2, qa 1, triager 1
- use `runs list` / `runs show` for completed task metrics, phase timings, log paths, and live-signal effective state
- use `verificationPlan` and `verificationRunners` as local verification capability metadata; use `verification.results` and logs as runner execution evidence
- expect structured evidence fields such as `evidenceType`, `flow`, `url`, `screenshots`, `consoleSummary`, `networkSummary`, and `eventIds` when browser/Nostr/GUI verification was performed
- expect verification to be worker-invoked during the task loop; automatic post-worker runner execution is opt-in, not the default architecture
- use `runs evidence <run-id>` to classify completion as evidence-backed, weak-evidence, blocked, failed, or needing human review
- use `runs repair-evidence <run-id>` when the worker likely completed the edit but evidence is missing, weak, or blocked
- use `runs continue <run-id> --task "..."` for broader follow-up on the same idle repo context
- continuation refuses busy contexts; do not bypass repo leases when a context is already active
- use `runs observe <run-id>` for a single-run live snapshot and `runs watch --active` for transition polling
- treat `runtime/orchestrator/observations.json` as the persisted last-seen observation state for run transitions
- treat `needs-review` as completed worker execution with insufficient evidence, not as a normal success
- distinguish `workerState` from `verificationState`; a worker can finish successfully while final web-runtime verification fails
- a detached launch means the worker process was started; it does not prove the run is still active or that the task succeeded
- after launching one-off jobs, re-check `openteam runs list`, `openteam runs show <run-id>`, or `openteam status` before telling the operator they are running or complete
- treat `state: "stale"` as authoritative even when `storedState: "running"` appears; `storedState` is only the raw run-file flag
- treat `state: "failed"` with `storedState: "succeeded"` as authoritative when diagnosis reports an OpenCode hard failure
- treat `verificationState: "failed"` and `failureCategory: "dev-server-unhealthy"` as a runtime verification failure, even if `workerState` is `succeeded`
- treat `failureCategory: "verification-failed"` or `"verification-blocked"` as failed worker-produced verification evidence, not as worker implementation success
- gate normal PR publication on `PR eligible: yes` from `runs evidence`; draft/WIP publication must be explicit
- if a failed `verify-dev-server` phase is followed by a succeeded `restart-dev-server` and `verify-dev-server-after-restart`, report it as recovered rather than silently ignoring the transient failure
- use `runs diagnose` for detailed evidence when a run is stale, logs are idle, process evidence is missing, or the dev URL is unreachable
- use `runs cleanup-stale --dry-run` to confirm stale records before cleanup; cleanup marks stale records terminal and releases repo leases without deleting checkouts
- use `browser attach` for live web-task observation details instead of guessing profile or artifact paths
- do not claim a web task URL is live unless `browser attach`, `browser status`, or `runs diagnose` reports the dev URL reachable
- if you are tempted to inspect or edit product code directly, stop and delegate to a worker instead
- workers should receive a ready-state managed repo context, not a raw unprovisioned checkout
- if a repo declares `.envrc` `use flake`, `flake.nix`, `shell.nix`, or `default.nix`, openteam should run provisioning and worker processes through that declared environment
- for outside-owned upstreams, that context should be the orchestrator-owned fork with upstream added as a remote
- workers should not receive instructions by DM; orchestrator-created local job envelopes are the instruction boundary
- researcher output should be a handoff brief; it should not submit PRs or make implementation changes

## Provisioning boundary

Provisioning sessions must prepare the managed repo context and then stop.

Hard rules:

- do not run `openteam launch`, `openteam enqueue`, `openteam serve`, or `openteam worker ...` from a provisioning session
- do not recursively hand off to another worker from provisioning
- if provisioning completes, return control to the launcher instead of acting as orchestrator
- if provisioning cannot prove readiness, fail clearly and leave the local repo context for operator inspection

## Launch parameters

Every worker launch should decide:

- role
- target
- mode: `web` or `code`
- model, when needed

Guidance:

- use `web` when browser/dev-server verification is genuinely needed
- use `code` for repository tasks that do not need a browser
- do not spend browser budget on code-only tasks

## Machine setup

The orchestrator runs as a normal user.

It may:

- inspect the machine toolchain
- suggest missing tools
- run user-level setup commands

Do not assume unrestricted root access.

When system-level packages are missing, explain the requirement clearly and prefer explicit install commands over hidden mutation.

## Communication boundary

- the orchestrator is the primary operator-facing DM target
- `dmRelays` are orchestrator control-plane relays, not worker instruction relays
- workers do not accept operator DMs
- workers may read/write assigned Nostr repository events such as issues, comments, labels, statuses, and PRs
- pass workers a managed repo context with `.openteam/repo-context.json`
- workers should use `openteam repo publish ...` for repo-side writes instead of raw relay selection
- workers should not rely on `gh auth` for Nostr-git PR publication; the default path is `git push origin <branch>` plus `openteam repo publish pr ...`
- use runtime-owned DM behavior for task status, not ad hoc messaging

## Summary

- resolve target first
- provision before handoff
- choose the smallest appropriate worker
- choose the right mode and model
- keep long-running workers explicit
- keep machine changes deliberate
- never directly do worker implementation tasks yourself
