# Operations

This document covers day-to-day operation of `openteam`.

## Config Files

Base defaults:

```text
config/openteam.json
```

Machine-specific config:

```text
config/openteam.local.json
```

Local secrets:

```text
config/openteam.secrets.env
```

## Important Variables

Common values expected in secrets/config:

- `OPENTEAM_APP_ROOT`
- optional GitHub/GitLab provider token env vars referenced by `config.providers`; openteam uses them to create/reuse fork repos and matches provider `host` to Git smart-HTTP clone/push URLs through `GIT_ASKPASS`
- `OPENTEAM_ORCHESTRATOR_01_SEC`
- `OPENTEAM_TRIAGER_01_SEC`
- `OPENTEAM_BUILDER_01_SEC`
- `OPENTEAM_RESEARCHER_01_SEC`
- `OPENTEAM_QA_01_SEC`
- `NOSTR_CLIENT_KEY` if used

Shared configuration lives primarily at the top level of `config/openteam.local.json`:

- `reporting.*` relay buckets and operator recipients
- `nostr_git.*` repo announcement, profile compatibility, and GRASP targets
- `browser.*`

Per-agent config should mostly contain identities, with transport overrides only when truly necessary.

## Core Commands

Local operator console:

```bash
openteam
```

This ensures the orchestrator is running and opens an operator-facing OpenCode console for freeform requests.

Sanity check:

```bash
bun run src/cli.ts doctor
```

Short orchestrator requests from CLI:

```bash
openteam "status"
openteam "start triager on 30617:<owner-pubkey>:<repo-d-tag>"
openteam "research nostr://<owner-npub>/<repo-d-tag> and identify the safest fix direction for issue <id>"
openteam "plan nostr://<owner-npub>/<repo-d-tag> and produce a builder handoff for <goal>"
openteam "work on <repo-hint-or-alias> as builder in web mode and do investigate issue comment UX"
openteam "work on nostr://<owner-npub>/<repo-d-tag> as builder and do fix the failing test"
openteam "work on nostr://<owner-npub>/<repo-d-tag> as builder in web mode in parallel and do investigate a separate issue"
```

Targets are Nostr-first.
Aliases, local paths, git URLs, and folder names are only hints; openteam must resolve the target to a kind `30617` repository announcement before it creates or reuses a local context.
Direct Nostr git URIs (`nostr://<owner-npub>/<repo-d-tag>`, optionally with relay hints) are resolved by discovering the owner's kind `10002` outbox relays, querying the repo announcement, and trying the announcement's ordered `clone` URLs.
Operator npubs in `reporting.allowFrom` are instruction authorities only; they do not own openteam-created repository announcements.
If the resolved repository owner is not `orchestrator-01`, openteam creates or reuses an orchestrator-owned fork announcement and works from that fork context.
Default fork storage priority is GitHub, then GitLab, then GRASP.
For GitHub and GitLab providers, openteam creates or reuses an empty repo through the configured provider token, pushes upstream heads/tags over Git smart HTTP, then announces the orchestrator-owned fork on Nostr.
For a dedicated user account, the token is enough because openteam looks up the authenticated account and uses the provider API response to get the clone URL.
Only organization or group targets need extra namespace config.
Configured GRASP servers are the fallback fork namespace: openteam derives fork clone URLs as `https://<grasp-server>/<orchestrator-npub>/<repo-d-tag>.git`, includes the derived GRASP relay URL in the fork announcement `relays` tag, announces the fork on Nostr, waits briefly for GRASP to create the writable repos, then pushes upstream heads/tags to the announced clone URLs.
For explicit non-provider deployments, fork population still uses normal Git smart HTTP: openteam derives or reads a writable fork clone URL, pushes upstream heads/tags to it, then announces the fork on Nostr.
For Nostr-native clone URLs that include the upstream owner npub/pubkey in the path, fork clone URL derivation replaces that owner path segment with the orchestrator npub and uses the repository announcement `d` tag as the fork repo name.
One-off jobs launched through the orchestrator get isolated runtime directories, state files, browser profiles, Playwright artifacts, logs, and run records.
Different Nostr repo targets can run concurrently.
The same canonical Nostr repo is serialized by default; use the explicit `in parallel` operator phrase, or `--parallel` on direct `launch`, to create a separate same-repo context.
Current one-off job limits are deliberately small: builder 2, researcher 2, qa 1, triager 1.

Prepare one agent workspace:

```bash
bun run src/cli.ts prepare builder-01
```

Direct one-off task:

```bash
bun run src/cli.ts launch researcher --target <repo-hint-or-30617-key> --mode code --task "Research options and produce a builder handoff"
bun run src/cli.ts launch builder --target <repo-hint-or-30617-key> --mode web --task "Investigate issue"
bun run src/cli.ts launch builder --target <repo-hint-or-30617-key> --mode web --parallel --task "Investigate separate issue"
```

This automatically seeds the selected worker identity from shared config before the task run begins.
Researcher tasks are read-only by default and include planning; their expected output is a handoff brief, not a patch or PR.

Long-lived worker loop:

```bash
bun run src/cli.ts serve orchestrator-01
```

Queue a task into a running worker:

```bash
bun run src/cli.ts enqueue builder --target <repo-hint-or-30617-key> --mode code --task "Build feature"
```

Start a managed long-running worker:

```bash
bun run src/cli.ts worker start triager --target <repo-hint-or-30617-key> --mode code --name triager-repo-a
```

This automatically seeds the selected worker identity from shared config before the worker process is started.
For triager workers, the target is resolved to a Nostr repo announcement and repo-scoped issue events can be converted into local triage jobs.
The worker still does not accept operator DMs.

List managed workers:

```bash
bun run src/cli.ts worker list
```

This prunes dead managed-worker PIDs from `runtime/orchestrator/workers.json` before printing.

Stop a managed worker:

```bash
bun run src/cli.ts worker stop triager-repo-a
```

Inspect recent task runs:

```bash
bun run src/cli.ts runs list --limit 10
bun run src/cli.ts runs show <run-id>
bun run src/cli.ts runs show <run-id> --raw
bun run src/cli.ts runs diagnose <run-id>
bun run src/cli.ts runs cleanup-stale --dry-run
bun run src/cli.ts runs cleanup-stale
bun run src/cli.ts runs stop <run-id>
```

`runs list` and `runs show` report effective state from live signals for running records.
If they print `state: "stale"` and `storedState: "running"`, trust `state`; `storedState` is only the raw run-file value.
Use `runs show --raw` only when you need the unmodified run record.
Use `runs diagnose` for detailed evidence when a worker appears idle, its logs stop moving, or its dev URL is unreachable.
Diagnosis checks recorded process PIDs, dev/browser URL health, recent log activity, and repo-context lease state.
`runs cleanup-stale --dry-run` shows which records would be marked stale and which repo contexts would be released.
The non-dry-run cleanup marks only stale records terminal and releases their leases; it does not delete repo checkouts.

Inspect or attach to a worker browser context:

```bash
bun run src/cli.ts browser status qa
bun run src/cli.ts browser attach qa
bun run src/cli.ts browser attach qa --open
```

`browser attach` prints the current task, dev URL when live, worker log, browser profile, and Playwright artifact directory.
If multiple live jobs have the same role, attach by worker name from `worker list` instead of by role.
`browser status` and `browser attach` health-check the dev URL before reporting it as live.
`--open` opens the live dev URL only while the worker is still running and the URL is reachable.
Do not open a worker profile while Playwright is actively using it; use the dev URL, logs, and artifacts for live observation.

Relay-list seeding:

```bash
bun run src/cli.ts relay sync builder-01
```

Profile data seeding:

```bash
bun run src/cli.ts profile sync builder-01
```

Notes:

- `relay sync` and `profile sync` are intentionally separate commands
- `profile sync` only publishes profile/config data
- `profile sync` inserts a short delay between profile event publishes to reduce relay-side rate limiting

## Bootstrap Order

Recommended order for a fresh agent identity:

1. fill config and secrets
2. run `doctor`
3. run `relay sync <agent>`
4. run `profile sync <agent>`
5. run one `launch <role> --target <repo> --task ...` bootstrap task
6. then move to `serve orchestrator-01` for long-running orchestration

After a repository context has been provisioned successfully, `openteam` reuses that managed normal-clone context when the registry says it is idle and compatible.
It does not use git worktrees and does not rely on git dirtiness to decide context reuse.
When a repo context is already leased, a second task for the same canonical repo fails closed unless the operator explicitly requests parallel work.
Parallel same-repo work creates a separate normal-clone context and separate task branch.

## Worker Management

### Foreground mode

Best for debugging and watching behavior.

Example:

```bash
bun run src/cli.ts serve builder-01
```

### Background mode

For ad hoc runs, backgrounding is possible, but managed services are preferred.

Recommended long-term path:

- `systemd --user`

Current unit files live in:

```text
systemd/
```

### Recommended service workflow

Install or copy user units, then use:

```bash
systemctl --user daemon-reload
systemctl --user start openteam-agent@orchestrator-01
systemctl --user status openteam-agent@orchestrator-01
journalctl --user -u openteam-agent@orchestrator-01 -f
```

Enable the primary orchestrator service:

```bash
systemctl --user enable openteam.target
systemctl --user start openteam.target
```

Keep services alive without interactive login:

```bash
sudo loginctl enable-linger <username>
```

## Logs and State

Runtime root:

```text
runtime/agents/<agentId>/
```

Important paths:

- `workspace/`
- `tasks/queue/`
- `tasks/history/`
- `artifacts/`
- `browser/`
- `state.json`

Repository context root:

```text
runtime/repos/
```

Important paths:

- `registry.json`
- `object-cache/`
- `contexts/`

`registry.json` stores upstream repo identities, fork mappings, and context leases.

Durable run records:

```text
runtime/runs/<agentId>-<taskId>.json
```

Each run record stores task identity, target, resolved repo/fork/context, log paths, browser profile/artifact paths, start/finish time, `durationMs`, final result, and phase timings for target resolution, provisioning, dev-server startup, worker execution, and cleanup.
New run records also store known process PIDs for the runner, provisioning OpenCode session, worker OpenCode session, dev server, and bunker where available.
Those PIDs are diagnostic evidence only; stale-run reconciliation also checks URL health and log freshness.

Typical things to inspect:

- runtime state: `runtime/agents/<agent>/state.json`
- run history: `runtime/runs/`
- repo context registry: `runtime/repos/registry.json`
- task logs in `artifacts/`
- worker logs in `runtime/logs/` if you run detached workers
- bunker log in the agent artifact directory

## What “Healthy” Looks Like

Healthy startup usually means:

- `doctor` finds `git`, `nak`, and `opencode`
- target hints resolve to a kind `30617` repository announcement
- outside-owned repositories resolve to an orchestrator-owned fork before worker handoff
- each launched task writes a `runtime/runs/` record with phase timings and final duration
- live web tasks report a reachable dev URL through `browser status` or `browser attach`
- relay sync shows no missing relay-list entries
- profile sync shows at least one accepted relay for the required profile data
- the browser bootstrap task can log in through the managed bunker
- the worker loop starts without repeated relay/auth errors
- orchestrator subscription-first DM intake stays connected, with polling only as fallback

## Known Imperfect States

These do not necessarily mean the system is broken:

- some bootstrap/directory relays reject or rate-limit relay-list writes
- some profile-data relays reject events they consider outside their accepted scope
- a subset of relays may fail as long as the required relay set still accepted the event
- old run records created before PID tracking may be marked stale when the worker is gone and the dev URL is dead
- a stale run can keep a repo context leased until `runs cleanup-stale` or `runs stop <run-id>` releases it

What matters is:

- required relay-list entries are discoverable
- required profile data is visible to the target client
- the agent can actually do its work

## Provisioning Boundary

The provisioning phase runs under an explicit runtime phase marker.
When `OPENTEAM_PHASE=provision`, the CLI rejects worker-control commands such as `launch`, `enqueue`, `serve`, and `worker`.
Provisioning sessions must prepare the managed repo context and then stop; they must not recursively launch or orchestrate other workers.

## Operational Warnings

- do not treat one relay-side rejection as a full failure automatically
- keep relay buckets semantically separated
- do not bypass Nostr repo announcement resolution with arbitrary local Git paths
- do not let workers operate from outside-owned repos directly when an orchestrator-owned fork is required
- do not send worker instructions by DM
- do not claim a browser URL is live unless `browser status`, `browser attach`, or `runs diagnose` confirms it is reachable
- do not expose raw agent secret keys to browser contexts
- let the runtime own operator DM reporting

## When To Re-seed

Re-run relay or profile sync when:

- you changed relay config
- you changed DM relay targets
- you changed outbox relay identity
- you changed signer relays and want fresh runtime state
- you changed GRASP server preference
- you changed provider tokens

## Current Limits

`openteam` currently provides the runtime foundation and skill-driven role behavior.

It does not yet provide:

- full hard separation of role permissions
- complete automated issue ingestion/routing pipelines
- complete PR publication automation

## Related Docs

- `docs/relay-model.md`
- `docs/event-model.md`
- `docs/skills.md`
- `docs/deployment.md`

Use the runtime plus skills to experiment first, then add automation only where the skill layer clearly falls short.
