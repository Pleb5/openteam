# openteam

`openteam` is a local control plane for agent workers that operate on a target web app with:

- isolated runtime state
- Nostr identities seeded from env-backed secrets
- one auto-managed `nak bunker` per running agent
- OpenCode headless runs
- dedicated browser/dev-server/task stacks
- markdown-based role, soul, and memory files

Current MVP:

- three runnable workers: `triager-01`, `builder-01`, and `qa-01`
- direct launch or queue-based serve loop
- target app worktree preparation
- target app dev server orchestration
- per-task OpenCode config generation
- Nostr DM task intake with immediate acknowledgement
- Nostr DM completion and blocker reporting
- browser-facing signer handoff through a managed bunker URI
- profile sync command for provider tokens and GRASP server preference

## Architecture

`openteam` is a small local control plane around three layers:

1. `OpenCode` sessions do the actual coding and browser work.
2. `openteam` owns orchestration, Nostr control-plane messaging, runtime state, and per-task isolation.
3. `nak bunker` is used as the signer backend for browser-facing NIP-46 login.

Per agent instance, `openteam` manages:

- one Nostr identity from env-backed secret material
- one runtime workspace with role/soul/memory bootstrap files
- one optional long-lived worker loop for DM intake and task execution
- one managed bunker process when browser work is active

Per task, `openteam` allocates:

- one git worktree
- one target app dev server on a free local port
- one dedicated browser profile and Playwright artifact directory
- one OpenCode session pointed at that isolated task stack

Control-plane responsibilities are split deliberately:

- runtime-owned: task intake by DM, immediate acknowledgement, completion/blocker reporting, relay/profile seeding
- agent-owned: code changes, browser interaction, app workflows, repo work, and task-specific Nostr operations when explicitly needed

The runtime keeps operator DMs deterministic and out of the agent prompt, while the agent keeps full autonomy over product and repo work inside its task sandbox.

## Commands

```bash
bun run src/cli.ts doctor
bun run src/cli.ts prepare builder-01
bun run src/cli.ts launch builder-01 --task "Investigate issue..."
bun run src/cli.ts serve builder-01
bun run src/cli.ts serve triager-01
bun run src/cli.ts serve qa-01
bun run src/cli.ts enqueue builder-01 --task "Build feature..."
bun run src/cli.ts relay sync builder-01
bun run src/cli.ts profile sync builder-01
```

## DM workflow

When `serve <agentId>` is running and DM relays, allowlist, and identity are configured:

- inbound DM body becomes the task text
- the agent immediately replies `working on it`
- the task is queued if the agent is already busy
- final status is sent back by DM on success or failure
- outbound DMs are published to both the agent's `dmRelays` and the recipient's discovered kind `10050` inbox relays

## Relay Buckets

- `dmRelays`: the agent's own messaging relays; used for inbound DM polling and also included in outbound DM publish for redundancy
- `outboxRelays`: the agent's own canonical relay list (`10002`); seeded at startup and used as part of relay-list publishing and general profile discoverability
- `relayListBootstrapRelays`: bootstrap/directory relays used to publish and discover the agent's `10002` and `10050` relay-list events
- `appDataRelays`: the agent's standard app-data relay set for general profile data
- `signerRelays`: relays used only for the auto-managed `nak bunker` / NIP-46 signer

## Nostr Git Preferences

- `agents.<id>.nostr_git.graspServers`: GRASP target relays the target app should remember for that agent identity
- `agents.<id>.nostr_git.gitDataRelays`: Nostr-git-specific fallback relays where git-related profile data should also be published so the current client can discover it reliably
- these are not DM relays and not signer relays
- `openteam profile sync <agentId>` publishes this preference separately so the target client can load it after login
- profile sync currently publishes to the union of `appDataRelays` and `nostr_git.gitDataRelays`
- keep `nostr_git.gitDataRelays` aligned with the current client's git relay set so agent profile data is available where the app looks for it

## Startup Seeding

When an agent starts, `openteam` now attempts to publish:

- kind `10002` with the agent's configured `outboxRelays`
- kind `10050` with the agent's configured `dmRelays`

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
- leave `identity.npub` blank if you want `openteam` to derive it from the secret key
- use `reporting.appDataRelays` for your standard relay set and `nostr_git.gitDataRelays` for the active client's git-data fallback relays
- use `reporting.outboxRelays` for the agent's canonical `10002` relay list
- use `reporting.dmRelays` for the agent's `10050` DM inbox relay list
- use `reporting.relayListBootstrapRelays` for bootstrap/directory relays like `purplepag.es`

## Runtime

Default runtime state lives under:

```text
./runtime/agents/<agentId>/
```

Each agent gets:

- `workspace/` for role/soul/memory bootstrap files
- `tasks/queue/` for queued tasks
- `artifacts/` for logs and outputs
- `worktrees/` for target-app git worktrees
- `browser/` for automation profiles

## Detailed Docs

- `docs/relay-model.md`
- `docs/event-model.md`
- `docs/skills.md`
- `docs/operations.md`
- `docs/deployment.md`

## Notes

- The MVP assumes a separate Playwright MCP command will be provided in local config.
- inbound DM control is disabled unless an allowlist is configured.
- if `identity.sec` is missing, DM control and managed bunker startup will not work for that agent.
- operator task-status DMs are runtime-owned; the agent should not send them manually unless the task itself is about Nostr messaging.
