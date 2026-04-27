# openteam

`openteam` is a local control plane for agent workers that operate on a target web app with:

- isolated runtime state
- Nostr identities seeded from env-backed secrets
- one auto-managed `nak bunker` per running agent
- OpenCode headless runs
- dedicated browser/dev-server/task stacks
- markdown-based role, soul, and memory files

Current MVP:

- one primary long-running orchestrator: `orchestrator-01`
- focused worker roles: `researcher-01`, `triager-01`, `builder-01`, and `qa-01`
- direct launches with explicit target, mode, and optional model
- Nostr-announced repository target resolution
- managed normal-clone repo contexts under the runtime directory
- bootstrap-first repository preparation
- target app dev server orchestration when running in web mode
- per-task OpenCode config generation
- Nostr DM task intake with immediate acknowledgement
- Nostr DM completion and blocker reporting
- browser-facing signer handoff through a managed bunker URI
- profile sync command for provider tokens and GRASP server preference

## Architecture

`openteam` is a small local control plane around three layers:

1. `OpenCode` sessions do the actual coding and browser work.
2. `openteam` owns orchestration, Nostr control-plane messaging, runtime state, target resolution, and per-task isolation.
3. `nak bunker` is used as the signer backend for browser-facing NIP-46 login.

Per agent instance, `openteam` manages:

- one Nostr identity from env-backed secret material
- one runtime workspace with role/soul/memory bootstrap files
- one optional long-lived worker loop for local queue or repository-event work
- one managed bunker process when browser work is active

The orchestrator is the primary long-running agent.
It is the only operator instruction ingress over CLI, console, or Nostr DM.
It resolves the target repository, chooses worker role and mode, provisions the repo context, and launches focused workers.
Operator authority is represented by allowlisted npubs in `reporting.allowFrom`; those npubs can instruct the orchestrator, but they do not own openteam-created repository announcements.
The orchestrator identity owns openteam-created repository announcements.

Repository identity is Nostr-first:

- every work target must resolve to a kind `30617` repository announcement
- local paths, git URLs, aliases, and folder names are only hints used to find that announcement
- direct targets can use `nostr://<owner-npub>/<repo-d-tag>`; openteam resolves owner outbox relays and reads the announcement before cloning
- if no announcement is found, openteam fails closed and asks the operator to announce the repository with their Nostr-git client first
- the canonical key is `30617:<owner-pubkey>:<repo-d-tag>`
- git-related collaboration terms are NIP-34/Nostr-git-first: issues, PRs/pull requests, comments/replies, labels, statuses, and repo threads mean repo-scoped Nostr-git events unless another forge is explicitly named
- if the repo owner is not `orchestrator-01`, openteam creates or reuses an orchestrator-owned Nostr-announced fork before worker handoff
- fork creation is Git smart-HTTP based: openteam creates or reuses a writable GitHub/GitLab/GRASP mirror, pushes upstream heads/tags to it, and signs the fork announcement with the orchestrator identity

Per task, `openteam` allocates:

- one managed repo context as a normal Git clone, backed by a local bare mirror cache and `--dissociate`
- one orchestrator-owned provisioning session when the repo is not already ready
- one target app dev server on a free local port when running in web mode
- one dedicated browser profile and Playwright artifact directory when running in web mode
- one OpenCode task session pointed at that isolated task stack

Control-plane responsibilities are split deliberately:

- runtime-owned: orchestrator DM task intake, immediate acknowledgement, fast grammar/freeform routing, important job reporting, relay/profile seeding
- orchestrator-owned: target resolution, repository provisioning before handoff, worker selection, mode/model selection, and worker lifecycle
- worker-owned: research briefs, code changes, browser interaction, app workflows, repo work, and task-specific Nostr operations when explicitly needed
- workers do not accept operator DMs; their Nostr capability is for identity, signing, repository-event reads/writes, and browser signer flows
- researcher is read-only by default and includes planning; it produces a handoff brief rather than implementation or PRs

Configuration is shared-first:

- top-level relay, profile, browser, and provider settings are the primary source
- worker identities inherit those defaults unless a worker explicitly overrides them
- worker-specific transport overrides should be exceptional

The runtime keeps operator DMs deterministic and out of the agent prompt, while the agent keeps full autonomy over product and repo work inside its task sandbox.

## Commands

```bash
bun run src/cli.ts doctor
bun run src/cli.ts prepare orchestrator-01
bun run src/cli.ts launch researcher --target 30617:<owner-pubkey>:<repo-d-tag> --mode code --task "Research the safest implementation plan..."
bun run src/cli.ts launch builder --target 30617:<owner-pubkey>:<repo-d-tag> --mode web --task "Investigate issue..."
bun run src/cli.ts serve orchestrator-01
bun run src/cli.ts enqueue builder --target <repo-hint-or-alias> --mode code --task "Build feature..."
bun run src/cli.ts worker start triager --target <repo-hint-or-alias> --mode code --name triager-repo-a
bun run src/cli.ts worker list
bun run src/cli.ts runs list --limit 10
bun run src/cli.ts runs diagnose <run-id>
bun run src/cli.ts runs evidence <run-id>
bun run src/cli.ts runs cleanup-stale --dry-run
bun run src/cli.ts browser attach qa
bun run src/cli.ts service restart
bun run src/cli.ts relay sync builder-01
bun run src/cli.ts profile sync builder-01
```

Running `scripts/openteam` with no arguments now:

1. ensures the `orchestrator-01` user service is installed and running
2. opens an operator-facing OpenCode console in the project root

The foreground console does not own the Nostr DM listener.
For code/config changes to openteam itself, restart the long-running listener with `openteam service restart`.

That console is the preferred local entrypoint for freeform operator requests.

Short operator request examples:

```bash
openteam "status"
openteam "start triager on 30617:<owner-pubkey>:<repo-d-tag>"
openteam "watch <repo-hint-or-alias> as triager"
openteam "research <repo-hint-or-alias> and compare the safest implementation options"
openteam "plan <repo-hint-or-alias> and produce a builder handoff for the failing sync flow"
openteam "work on <repo-hint-or-alias> as builder in web mode and do investigate issue comment UX"
openteam "work on <repo-hint-or-alias> as builder in web mode in parallel and do investigate a separate issue"
```

Worker launch commands automatically seed the selected worker identity from shared config before work begins.
One-off worker jobs launched by the orchestrator use isolated runtime ids, state files, browser profiles, Playwright artifacts, logs, and run records.
Same-repo tasks are serialized by default; `in parallel` explicitly creates a separate same-repo context.
Default one-off job limits are intentionally small: builder 2, researcher 2, qa 1, triager 1.
Run records are written to `runtime/runs/` with total duration, phase timings, context details, log paths, and browser artifact paths.
`openteam status` refreshes `runtime/status.json` with live worker counts, effective run-state counts, stale lease counts, and last cleanup metadata.
Worker processes receive checkout-local temp/cache/artifact env vars under `.openteam/` so repro clones, generated logs, downloads, and package caches do not depend on host-global paths like `/tmp`.
If a checkout declares a Nix dev environment with `.envrc`, `flake.nix`, `shell.nix`, or `default.nix`, openteam runs provisioning, worker OpenCode, and web dev-server processes through it and records the selected `devEnv` in the run record.
openteam also writes `.openteam/project-profile.json` with detected project hints such as Rust, Node, Go, Python, Gradle/Android, Swift/iOS, docs, and likely validation commands.
Those hints are a checklist only; repo docs, declared scripts, and declared dev environments override them.
openteam also writes `.openteam/verification-plan.json` with the local verification runners selected for the run.
Workers use `openteam verify list`, `openteam verify run <runner-id>`, `openteam verify browser ...`, `openteam verify artifact ...`, and `openteam verify record <runner-id> ...` during their own loop to record structured verification evidence.
The launcher collects worker-produced evidence from `.openteam/verification-results.json`; failed or blocked worker evidence fails the run.
Automatic post-worker runner execution is disabled by default with `verification.autoRunAfterWorker: false`.
If evidence is missing or weak after a successful worker phase, the run finishes as `needs-review` instead of plain `succeeded`.
Normal `repo publish pr` / `pr-update` publication is blocked until `openteam runs evidence <run-id>` reports `PR eligible: yes`, unless draft/WIP publication is explicit.
Mobile-native runner tools are guarded and disabled by default; they never install SDKs, emulators, or system packages.
For live web tasks, `openteam browser attach <agent-or-role>` health-checks the dev URL before reporting it as live or offering an open command.
Web runs track `workerState` separately from `verificationState`; a builder can complete the OpenCode task phase but still fail final web-runtime verification.
If final dev-server verification fails after a successful worker phase, openteam restarts the dev server once and verifies again before deciding success or `failureCategory: "dev-server-unhealthy"`.
`openteam runs list` and `openteam runs show <run-id>` report effective stale state from live signals; if `state` is `stale` and `storedState` is `running`, trust `state`.
They also report `state: failed` over stored `succeeded` when the OpenCode log contains a hard infrastructure failure such as a provider `server_error` or sandbox permission rejection.
They also report effective failed state when `workerState` or `verificationState` failed.
Use `openteam runs show <run-id> --raw` only when you need the unmodified run file.
Use `openteam runs observe <run-id>` for a compact live snapshot and `openteam runs watch --active` for transition polling.
The long-running orchestrator service runs the same observer and persists last-seen transitions in `runtime/orchestrator/observations.json`.
If a run looks active but the process, URL, or logs disagree, use `openteam runs diagnose <run-id>` and `openteam runs cleanup-stale --dry-run` before cleaning stale leases.
Use `openteam runs repair-evidence <run-id>` to relaunch the same idle repo context with prior successful evidence, missing-evidence guidance, and PR blockers in the worker prompt.
Use `openteam runs continue <run-id> --task "..."` for broader follow-up work on the same context; busy contexts are refused rather than hijacked.

## DM workflow

When `serve orchestrator-01` is running and DM relays, allowlist, and identity are configured:

- inbound operator DMs are accepted only from `reporting.allowFrom`
- the orchestrator immediately replies `working on it` with the source DM event id
- fast grammar commands are dispatched without invoking the conversational agent: `help`, `status`, `worker list`, `what is running?`, `stop <worker-name>`, `start <role> on <target>`, `watch <target> [as <role>]`, `research <target> and <task>`, `plan <target> and <goal>`, and `work on <target> ... and do <task>`
- unmatched DMs fall back to the conversational orchestrator path, the same control style as the local TUI, and return only a concise operator-facing response
- DM-originated jobs carry the sender as a report recipient through detached worker launches
- TUI/CLI-originated jobs send important lifecycle DMs to `reporting.reportTo` when configured
- important reports include launched/started, browser URL available, failed, needs-review/succeeded, and warning/critical run observations; routine phase noise and raw logs are not DM'd
- outbound DMs are published to both the orchestrator's `dmRelays` and the recipient's discovered kind `10050` inbox relays

`reporting.allowFrom` is an authority list, not a notification subscription list.
Use `reporting.reportTo` for default job notifications from local TUI/CLI work.

Worker agents do not publish or subscribe to operator DM control inboxes.
They can still use Nostr repository relays for issue, comment, label, status, and PR workflows when the orchestrator assigned task requires it.
Long-running triager workers may watch repo-scoped kind `1621` issue events and convert them into local triage jobs; those events are treated as inputs, not external instructions.
Managed repo contexts include `.openteam/repo-context.json`, and workers should use `openteam repo policy` plus `openteam repo publish ...` for repo-side writes instead of selecting relays manually.

## Relay Buckets

These buckets are configured primarily at the top level and inherited by workers by default.

- `dmRelays`: the orchestrator's operator messaging relays; used for inbound DM polling and outbound operator-facing DMs
- `allowFrom`: npubs authorized to issue orchestrator control DMs
- `reportTo`: npubs that receive important job reports for local TUI/CLI-launched work; DM-launched work also reports to the sender
- `outboxRelays`: the agent's own canonical relay list (`10002`); seeded at startup and used as part of relay-list publishing and general profile discoverability
- `relayListBootstrapRelays`: bootstrap/directory relays used to publish and discover the agent's `10002` and `10050` relay-list events
- `appDataRelays`: the agent's standard app-data relay set for general profile data
- `signerRelays`: relays used only for the auto-managed `nak bunker` / NIP-46 signer

## Nostr Git Preferences

- `providers`: Git smart-HTTP token targets; GitHub and GitLab providers are used for orchestrator-owned fork storage before GRASP
- `nostr_git.graspServers`: GRASP target relays the target app should remember for agent identities, and the fallback fork storage namespace for orchestrator-owned forks
- `nostr_git.gitDataRelays`: Nostr-git-specific fallback relays where git-related profile data should also be published so the current client can discover it reliably
- `nostr_git.repoAnnouncementRelays`: fallback relays used to discover kind `30617` repository announcements
- default fork storage priority is GitHub, then GitLab, then GRASP
- GRASP-backed forks are announced with clone URLs like `https://<grasp-server>/<orchestrator-npub>/<repo-d-tag>.git`
- when any GRASP clone URL is used for storage, the fork announcement `relays` tag contains the derived GRASP relay URL, such as `wss://<grasp-server>`
- `nostr_git.forkGitOwner`: optional fallback owner/path segment for fork smart-HTTP URLs when GRASP servers are unavailable and the announced clone URL does not contain the upstream owner npub/pubkey
- `nostr_git.forkRepoPrefix`: optional prefix for the fork repository announcement `d` tag
- `nostr_git.forkCloneUrlTemplate`: explicit smart-HTTP fork URL template, only for non-GRASP deployments
- these are not DM relays and not signer relays
- `openteam profile sync <agentId>` publishes this preference separately so the target client can load it after login
- profile sync currently publishes to the union of `appDataRelays` and `nostr_git.gitDataRelays`
- keep `nostr_git.gitDataRelays` aligned with the current client's git relay set so agent profile data is available where the app looks for it

## Startup Seeding

When an agent starts, `openteam` now attempts to publish:

- kind `10002` with the agent's configured `outboxRelays`
- kind `10050` with the agent's configured `dmRelays`, only for the orchestrator

These relay-list events are published to the union of:

- `outboxRelays`
- `relayListBootstrapRelays`

This makes relay-list events discoverable without turning the DM relay set itself into a relay-list write target.

This gives the agent a ready relay identity before any browser or repo task begins.
You can also force it manually with:

```bash
bun run src/cli.ts relay sync <agentId>
```

## Signer Model

- Core DMs and app-data events are handled in-process with `nostr-tools`
- `nak bunker` is started automatically for each running agent using `signerRelays`
- the generated `bunker://...` URI is written into the runtime identity file and injected into the
  task prompt so the browser agent can log into the target app with Remote Signer
- `nak` remains available for task-time use through the agent tool layer, not as the control plane

## Config

- Base defaults live in `config/openteam.json`
- Machine-specific relays and agent settings belong in `config/openteam.local.json`
- Local secrets belong in `config/openteam.secrets.env`
- Agent metadata lives in `agents/*.json`

The launcher merges `config/openteam.json` with `config/openteam.local.json`.
If `config/openteam.secrets.env` exists, it is loaded automatically before config expansion.

Agent secrets are expected to come from environment variables referenced by the local config.
`openteam` uses those secrets directly for core Nostr logic and starts a local `nak bunker`
for each running agent so browser flows can use NIP-46 without exposing the raw secret in the target app.

Practical edit points:

- write relays, allowlists, and browser MCP command in `config/openteam.local.json`
- write Git tokens and Nostr secrets in `config/openteam.secrets.env`
- map GitHub/GitLab token hosts under `config.providers`; openteam can create/reuse fork repos there and injects matching Git smart-HTTP tokens through `GIT_ASKPASS` without embedding tokens in URLs
- publish Nostr-git PRs with branch push plus `openteam repo publish pr ...`; personal `gh auth` is not part of the default openteam path, normal PR publication requires strong verification evidence, and `--target-branch` is only for the merge target branch
- leave `identity.npub` blank if you want `openteam` to derive it from the secret key
- use `reporting.appDataRelays` for your standard relay set and `nostr_git.gitDataRelays` for the active client's git-data fallback relays
- use `nostr_git.repoAnnouncementRelays` for repository announcement fallback discovery
- use `agents.orchestrator-01.identity` for openteam-created fork announcements
- use GitHub/GitLab `providers` for the preferred orchestrator-owned fork namespace
- for a dedicated GitHub/GitLab user account, the token is enough; openteam looks up the authenticated account and uses the API-returned clone URL
- configure `namespace` for a GitHub organization, or `namespaceId` plus `namespacePath` for a GitLab group namespace
- use `nostr_git.graspServers` as the fallback orchestrator-owned fork namespace
- use `nostr_git.forkCloneUrlTemplate` only as an explicit override
- use `reporting.outboxRelays` for the agent's canonical `10002` relay list
- use `reporting.dmRelays` for the orchestrator's `10050` DM inbox relay list
- use `reporting.relayListBootstrapRelays` for bootstrap/directory relays like `purplepag.es`

Repo targets may be direct Nostr git URIs such as `nostr://<owner-npub>/<repo-d-tag>`.
For those targets, openteam discovers the owner's kind `10002` outbox relays, queries the kind `30617` repository announcement there plus configured fallback relays, reads ordered `clone` URLs from the announcement, and tries those clone URLs in order.
The `nostr://` URI is the canonical Nostr identity; actual Git object transfer still uses the Git smart HTTP/SSH clone URLs announced by the repo.
When the target is outside-owned, openteam first tries to create/reuse a GitHub fork repo from configured GitHub tokens, then GitLab, then GRASP.
For GitHub and GitLab, openteam creates the empty repository through the provider API, pushes upstream refs, then publishes the orchestrator-owned kind `30617` fork announcement.
For GRASP, openteam publishes the fork announcement first, includes the GRASP relay URL in the announcement `relays` tag, waits briefly for GRASP to create the writable Git repository, then pushes upstream refs.

## Runtime

Default runtime state lives under:

```text
./runtime/agents/<agentId>/
```

Each agent gets:

- `workspace/` for role/soul/memory bootstrap files
- `tasks/queue/` for queued tasks
- `artifacts/` for logs and outputs
- `browser/` for automation profiles

Repository runtime state lives under:

```text
./runtime/repos/
```

It contains:

- `registry.json` for canonical Nostr repo identities and managed context leases
- fork mappings from upstream Nostr repos to orchestrator-owned Nostr repo announcements
- `object-cache/` for Nostr-repo-keyed bare mirror caches
- `contexts/` for normal Git checkout contexts assigned to workers

Task run history lives under:

```text
./runtime/runs/
```

Each run record captures the resolved Nostr repo/fork/context, final result, `workerState`, `verificationState`, `failureCategory`, `durationMs`, phase timings, log files, browser observability paths, and worker-produced `verification.results`.
Each run also stores a done contract describing required evidence, success policy, and PR policy for the role/task class.
Use `openteam runs evidence <run-id>` for the compact evidence view, including grouped repo-native, browser, Nostr, desktop, mobile, manual, and runtime evidence.
New run records also capture known runner, provisioning, worker, dev-server, and bunker PIDs where available.
`runs diagnose` uses those PIDs plus dev URL health, log freshness, and context lease state to detect stale records.
`runtime/status.json` is generated by `status` and stale-run cleanup commands as a compact operational snapshot. It is not authoritative state; use run records and `runtime/repos/registry.json` for source-of-truth debugging.

Provisioning runs with `OPENTEAM_PHASE=provision`.
In that phase, the CLI rejects worker-control commands such as `launch`, `enqueue`, `serve`, and `worker` so provisioning cannot recursively hand off to another worker.

## Detailed Docs

- `docs/relay-model.md`
- `docs/event-model.md`
- `docs/invariants.md`
- `docs/skills.md`
- `docs/operations.md`
- `docs/local-verification.md`
- `docs/deployment.md`
- `docs/tenex-lessons-plan.md`

## Notes

- The MVP assumes a separate Playwright MCP command will be provided in local config.
- inbound DM control is orchestrator-only and disabled unless an allowlist is configured.
- if `identity.sec` is missing, DM control and managed bunker startup will not work for that identity.
- operator task-status DMs are runtime-owned; workers should not send them manually.
- `web` mode starts dev server + browser phase after bootstrap succeeds.
- `code` mode skips browser/dev startup and is suitable for non-web repositories.
