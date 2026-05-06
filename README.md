# openteam

`openteam` is a local runtime for running a small team of Nostr-aware coding agents against real repositories.

An operator gives work to one orchestrator.
The orchestrator resolves a Nostr-git repository, prepares an isolated checkout, launches the right OpenCode worker, manages browser and dev-server context when needed, collects structured verification evidence, and gates publication on that evidence.

The goal is not to replace a forge, CI, or an operator.
The goal is to make repo work delegable to local agents with clear identity, isolation, observability, and publication policy.

## What It Is

`openteam` is a Nostr-first agent workforce for repository work:

- one long-running orchestrator identity for operator intake and delegation
- focused worker identities for research, triage, building, and QA
- Nostr-git repository targeting through kind `30617` announcements
- orchestrator-owned fork/context preparation before worker handoff
- normal Git checkouts isolated per task under the local runtime directory
- OpenCode headless worker sessions with role, soul, memory, and task prompts
- optional web-mode dev server, browser profile, and browser artifacts per run
- structured run records and verification evidence for later inspection
- Nostr DM task intake and sparse lifecycle reporting for allowlisted operators

The product model is intentionally local-first.
Your machine owns the runtime, credentials, browser sessions, checkouts, logs, and final publication decisions.

## Core Loop

1. The operator asks `orchestrator-01` to do repo work from the local console, CLI, or an allowlisted Nostr DM.
2. The orchestrator resolves the target to a Nostr-git repository announcement.
3. If needed, the orchestrator creates or reuses an orchestrator-owned fork announcement and writable Git backing store.
4. The runtime provisions an isolated repo context, task state, logs, browser profile, and artifact paths.
5. The orchestrator launches the best worker role and mode for the task.
6. The worker inspects the repo, performs the work, and records verification evidence with local tools.
7. The runtime collects the worker result, evidence, logs, browser state, and run metadata.
8. Publication helpers block normal PR/update publication until the evidence contract is satisfied, unless draft/WIP publication is explicit.

## Roles

- `orchestrator-01`: operator ingress, target resolution, repo provisioning, worker routing, lifecycle observation, and publication gating.
- `researcher-01`: read-only investigation and implementation planning; produces handoff briefs rather than patches.
- `triager-01`: issue intake, reproduction notes, labels/statuses, routing, and long-running repo watch flows.
- `builder-01`: implementation work, tests, browser interaction, verification evidence, and PR/update preparation.
- `qa-01`: user-behavior validation, browser-first reproduction, regression checks, and evidence-focused QA reports.

Workers do not accept operator control DMs.
Their Nostr capability is for identity, signing, repository-event reads/writes, and browser signer flows when the assigned task requires it.

## What Makes It Different

- Nostr-first repo identity: aliases, local paths, and git URLs are hints; the canonical work target is a Nostr-git repo announcement.
- Orchestrator-owned delegation: operators instruct one orchestrator, and the orchestrator prepares safe worker contexts.
- Isolated local execution: each one-off task gets separate checkout state, browser profile, artifacts, logs, and run records.
- Real app verification: web-mode jobs can run the target app locally and verify through browser tooling instead of only summarizing code changes.
- Evidence-based outcomes: successful worker exit is not enough; missing or weak evidence can leave a run in `needs-review`.
- Publication policy: normal Nostr-git PR publication is gated on recorded evidence, with explicit draft/WIP escape hatches.
- Local control: secrets, provider tokens, relays, signer setup, and runtime state stay on the operator machine.

## Quickstart

Prerequisites: Bun, OpenCode, Git, and `nak`.
The external `agent-browser` CLI is optional for browser verification.

Install dependencies:

```bash
bun install
```

Start from the example config files:

```bash
cp -n config/openteam.local.example.json config/openteam.local.json
cp -n config/openteam.secrets.env.example config/openteam.secrets.env
```

Edit local config and secrets for your machine:

- `config/openteam.local.json` for relays, browser settings, provider mappings, and operator allowlists
- `config/openteam.secrets.env` for Nostr secret keys and Git provider tokens
- `agents/*.json` for agent metadata

Run a sanity check:

```bash
bun run src/cli.ts doctor
```

Prepare the orchestrator workspace:

```bash
bun run src/cli.ts prepare orchestrator-01
```

Open the local operator console:

```bash
./scripts/openteam
```

The console ensures the `orchestrator-01` service is running and opens an operator-facing OpenCode session in this project.
For changes to `openteam` itself, restart the long-running listener after editing:

```bash
./scripts/openteam service restart
```

## Common Commands

Common operator requests:

```bash
./scripts/openteam "status"
./scripts/openteam "research nostr://<owner-npub>/<repo-d-tag> and identify the safest fix direction for issue <id>"
./scripts/openteam "plan nostr://<owner-npub>/<repo-d-tag> and produce a builder handoff for <goal>"
./scripts/openteam "work on nostr://<owner-npub>/<repo-d-tag> as builder and do fix the failing test"
./scripts/openteam "work on <repo-hint-or-alias> as builder in web mode and do investigate issue comment UX"
```

Direct CLI launches when you need explicit flags:

```bash
bun run src/cli.ts launch researcher --target 30617:<owner-pubkey>:<repo-d-tag> --mode code --task "Research options and produce a builder handoff"
bun run src/cli.ts launch builder --target 30617:<owner-pubkey>:<repo-d-tag> --mode web --task "Investigate issue"
```

Non-interactive worker launches default to detached execution so OpenCode/Bash command timeouts do not kill the worker, dev server, and browser runtime. Add `--attach` only for foreground debugging.

Run inspection and browser attach:

```bash
bun run src/cli.ts runs list --limit 10
bun run src/cli.ts runs show <run-id>
bun run src/cli.ts runs evidence <run-id>
bun run src/cli.ts runs diagnose <run-id>
bun run src/cli.ts browser attach builder
```

Start or inspect long-running workers:

```bash
bun run src/cli.ts worker start triager --target <repo-hint-or-alias> --mode code --name triager-repo-a
bun run src/cli.ts worker list
```

## Target Model

Repository targets should resolve to Nostr-git kind `30617` announcements.
Direct targets can use either canonical keys or Nostr git URIs:

```text
30617:<owner-pubkey>:<repo-d-tag>
nostr://<owner-npub>/<repo-d-tag>
```

Local paths, git URLs, aliases, and folder names are accepted only as resolution hints.
If no repository announcement can be found, `openteam` fails closed and asks for a Nostr-git announcement first.

## Operating Notes

- `code` mode skips browser/dev-server startup and is suitable for non-web tasks.
- `web` mode provisions the target app dev server and browser context after repo bootstrap succeeds.
- Same-repo one-off jobs are serialized by default; use an explicit parallel request only when separate same-repo contexts are safe.
- Inbound Nostr DM control is orchestrator-only and requires `reporting.allowFrom`.
- Important lifecycle reports can be sent to configured `reporting.reportTo` recipients.
- Run records live under `runtime/runs/`; managed repo contexts live under `runtime/repos/`.
- Use `openteam runs evidence <run-id>` before publishing normal PR/update events.

## Documentation Map

- `docs/operations.md`: day-to-day commands, config, target resolution, runtime state, and repair flows.
- `docs/local-verification.md`: worker-facing verification tools, evidence levels, browser evidence, and PR gates.
- `docs/relay-model.md`: relay buckets and Nostr relay-list behavior.
- `docs/event-model.md`: Nostr event kinds used by the runtime and repo workflows.
- `docs/invariants.md`: safety and architecture invariants that should not drift.
- `docs/skills.md`: OpenCode skill packaging and task guidance.
- `docs/deployment.md`: service installation and deployment notes.
- `roles/*.md`: role-specific prompt policy for orchestrator and worker agents.
