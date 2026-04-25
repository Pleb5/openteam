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
- focused worker roles: `triager-01`, `builder-01`, and `qa-01`
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
- if the repo owner is not `orchestrator-01`, openteam creates or reuses an orchestrator-owned Nostr-announced fork before worker handoff
- fork creation is Git smart-HTTP based: openteam creates or reuses a writable GitHub/GitLab/GRASP mirror, pushes upstream heads/tags to it, and signs the fork announcement with the orchestrator identity

Per task, `openteam` allocates:

- one managed repo context as a normal Git clone, backed by a local bare mirror cache and `--dissociate`
- one orchestrator-owned provisioning session when the repo is not already ready
- one target app dev server on a free local port when running in web mode
- one dedicated browser profile and Playwright artifact directory when running in web mode
- one OpenCode task session pointed at that isolated task stack

Control-plane responsibilities are split deliberately:

- runtime-owned: orchestrator DM task intake, immediate acknowledgement, completion/blocker reporting, relay/profile seeding
- orchestrator-owned: target resolution, repository provisioning before handoff, worker selection, mode/model selection, and worker lifecycle
- worker-owned: code changes, browser interaction, app workflows, repo work, and task-specific Nostr operations when explicitly needed
- workers do not accept operator DMs; their Nostr capability is for identity, signing, repository-event reads/writes, and browser signer flows

Configuration is shared-first:

- top-level relay, profile, browser, and provider settings are the primary source
- worker identities inherit those defaults unless a worker explicitly overrides them
- worker-specific transport overrides should be exceptional

The runtime keeps operator DMs deterministic and out of the agent prompt, while the agent keeps full autonomy over product and repo work inside its task sandbox.

## Commands

```bash
bun run src/cli.ts doctor
bun run src/cli.ts prepare orchestrator-01
bun run src/cli.ts launch builder --target 30617:<owner-pubkey>:<repo-d-tag> --mode web --task "Investigate issue..."
bun run src/cli.ts serve orchestrator-01
bun run src/cli.ts enqueue builder --target <repo-hint-or-alias> --mode code --task "Build feature..."
bun run src/cli.ts worker start triager --target <repo-hint-or-alias> --mode code --name triager-repo-a
bun run src/cli.ts worker list
bun run src/cli.ts runs list --limit 10
bun run src/cli.ts browser attach qa
bun run src/cli.ts relay sync builder-01
bun run src/cli.ts profile sync builder-01
```

Running `scripts/openteam` with no arguments now:

1. ensures `orchestrator-01` is running
2. opens an operator-facing OpenCode console in the project root

That console is the preferred local entrypoint for freeform operator requests.

Short operator request examples:

```bash
openteam "status"
openteam "start triager on 30617:<owner-pubkey>:<repo-d-tag>"
openteam "watch <repo-hint-or-alias> as triager"
openteam "work on <repo-hint-or-alias> as builder in web mode and do investigate issue comment UX"
openteam "work on <repo-hint-or-alias> as builder in web mode in parallel and do investigate a separate issue"
```

Worker launch commands automatically seed the selected worker identity from shared config before work begins.
One-off worker jobs launched by the orchestrator use isolated runtime ids, state files, browser profiles, Playwright artifacts, logs, and run records.
Same-repo tasks are serialized by default; `in parallel` explicitly creates a separate same-repo context.
Default one-off job limits are intentionally small: builder 2, qa 1, triager 1.
Run records are written to `runtime/runs/` with total duration, phase timings, context details, log paths, and browser artifact paths.
For live web tasks, `openteam browser attach <agent-or-role>` prints the dev URL, worker log, browser profile, and Playwright artifact directory.

## DM workflow

When `serve orchestrator-01` is running and DM relays, allowlist, and identity are configured:

- inbound DM body becomes the task text
- the orchestrator immediately replies `working on it`
- the task is queued if the agent is already busy
- final status is sent back by DM on success or failure
- outbound DMs are published to both the orchestrator's `dmRelays` and the recipient's discovered kind `10050` inbox relays

Worker agents do not publish or subscribe to operator DM control inboxes.
They can still use Nostr repository relays for issue, comment, label, status, and PR workflows when the orchestrator assigned task requires it.
Long-running triager workers may watch repo-scoped kind `1621` issue events and convert them into local triage jobs; those events are treated as inputs, not external instructions.
Managed repo contexts include `.openteam/repo-context.json`, and workers should use `openteam repo policy` plus `openteam repo publish ...` for repo-side writes instead of selecting relays manually.

## Relay Buckets

These buckets are configured primarily at the top level and inherited by workers by default.

- `dmRelays`: the orchestrator's operator messaging relays; used for inbound DM polling and outbound operator-facing DMs
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

Each run record captures the resolved Nostr repo/fork/context, final result, `durationMs`, phase timings, log files, and browser observability paths.

## Detailed Docs

- `docs/relay-model.md`
- `docs/event-model.md`
- `docs/skills.md`
- `docs/operations.md`
- `docs/deployment.md`

## Notes

- The MVP assumes a separate Playwright MCP command will be provided in local config.
- inbound DM control is orchestrator-only and disabled unless an allowlist is configured.
- if `identity.sec` is missing, DM control and managed bunker startup will not work for that identity.
- operator task-status DMs are runtime-owned; workers should not send them manually.
- `web` mode starts dev server + browser phase after bootstrap succeeds.
- `code` mode skips browser/dev startup and is suitable for non-web repositories.
