# Agentic Verification, Loom, and openteam Notes

Date: 2026-04-28

This note captures the architecture discussion around making openteam more stable, using concise observability, broadening verification without inventing a provisioning format, and integrating Loom as a remote verification backend.

## Starting Problem

openteam was seeing too many failed runs followed by automatic re-runs. The orchestrator approach still makes sense for agent management and workspace management, but stability depends on tighter run-state semantics and better evidence handling.

The immediate direction was:

- make verification tooling reliable before worker handoff
- reduce noisy DM reporting while preserving enough metadata to identify runs and outcomes
- treat `needs-review`, failed verification, permission rejection, publication blocked, and context-busy as operator-review states instead of automatic continuation triggers
- remove deprecated git worktree references from tracked source/docs/config paths
- add an orchestrator stability plan with explicit loop-stopping rules

Related local docs:

- `docs/dm-observability-reporting-plan.md`
- `docs/orchestrator-stability-plan.md`
- `docs/local-verification.md`

## Current Reliable Provisioning Surface

openteam is currently most reliable for repo-contained web apps and desktop apps that can be treated as build/test/code projects.

High-confidence project types:

- Nix-declared web apps using `flake.nix`, `.envrc use flake`, `shell.nix`, or `default.nix`
- conventional Node web apps with clear `package.json` scripts and lockfiles
- Vite-style SPA projects, especially when `repo.devCommand` and `repo.healthUrl` are configured
- monorepos launched from the actual workspace root with workspace manifests present

Reliable with conditions:

- full-stack web apps when service dependencies are declared or already available
- Electron build/test work when scripts and system dependencies are clear
- Tauri build/test work when Rust, Node, and system dependencies are declared through Nix or the host
- native GTK/Qt/CMake/Meson projects when repo-native commands work inside the declared environment

Low confidence for now:

- partial monorepo package checkouts with `workspace:` dependencies and missing workspace manifests
- apps requiring unmanaged databases, queues, Docker Compose services, or host services
- full desktop GUI automation
- installers, packaging, notarization, signing, macOS/Windows-specific desktop behavior from a Linux host

The practical classification should be explicit:

- supported
- supported with declared services
- best effort
- blocked due to missing tooling

## Provisioning Philosophy

We do not need a new provisioning format.

The durable split is:

1. Detect what the repo already declares.
2. Provision what openteam supports locally.
3. Outsource what needs a different environment.
4. Normalize all local and remote evidence into the same run evidence model.

Existing declarations should stay authoritative:

- Nix flakes and shells
- package-manager scripts and lockfiles
- Dev Containers
- CI workflow files
- repo documentation
- explicit runner configuration

openteam should not become a universal provisioner. It should coordinate existing environment contracts and verification adapters.

## Agentic Verification Rationale

Agentic verification is useful if it is framed as confidence-gathering and exploratory QA, not as mathematical proof of correctness.

The strongest use case is:

1. run deterministic repo-native checks
2. let an agent inspect product behavior with real tools, real accounts, browser sessions, Nostr relays, devices, or backends
3. record concrete evidence
4. turn repeated useful findings into deterministic checks over time
5. stop when confidence cannot increase because required tooling is missing

Evidence should be ranked by trust:

| Evidence type | Trust |
| --- | --- |
| deterministic local command at exact commit | high |
| deterministic remote command at exact commit | high |
| browser or Playwright flow with screenshots/logs | medium-high |
| agentic QA finding with artifacts and reproduction notes | medium |
| freeform agent statement with no artifacts | low |
| unknown remote worker with no reproducible artifacts | low |

The core rule:

> Agents can do judgment work, but every result must leave inspectable evidence.

Public examples and related projects discussed:

- Stagehand and Browserbase: browser automation with natural-language primitives and agent fallback
- Momentic: AI-powered E2E testing and autonomous test generation
- Magnitude: AI-native web app testing with planner/executor architecture
- Reflect: prompt-based E2E test steps
- Quell: AI QA agent for acceptance testing from product workflows
- EPAM Agentic QA: enterprise productization around agentic QA
- Playwright MCP and related HN discussions around browser agents, context size, flakiness, and deterministic fallback

## Loom As Remote Verification

Loom is a natural remote verification backend for openteam.

The right first integration is a remote command runner, not MCP and not remote OpenCode by default.

Recommended shape:

```text
openteam worker edits code locally
-> openteam pushes branch or uploads patch bundle
-> openteam submits Loom job
-> Loom worker runs exact command against exact commit
-> result returns with stdout/stderr artifacts
-> openteam records remote evidence
-> orchestrator accepts, continues, or stops with blocker
```

Useful runner tiers:

| Tier | Use | Default |
| --- | --- | --- |
| Loom command runner | build/test/check/browser scripts | yes |
| Loom product smoke runner | Playwright, Electron/Tauri smoke commands, screenshots | yes when declared |
| Loom OpenCode runner | exploratory reproduction and unknown failures | escalation only |
| MCP tunnel | live interactive browser/desktop control | later/special case |

Suggested openteam runner ids:

- `loom-command`
- `loom-act`
- `loom-nostr-command`
- `loom-browser-command`
- `loom-opencode` as explicit escalation only

## loom-adapter-lima Inspection

`~/Work/loom-adapter-lima` is an execution backend behind a Loom worker. It does not speak Nostr event kinds itself.

It provides:

- a Deno daemon
- Unix socket protocol with line-delimited JSON
- hot Lima VM pool
- VM acquisition when a pool slot is ready
- stdout/stderr streaming
- exit code and duration reporting
- delete-and-reclone recycling after each job
- Ubuntu 24.04 template with Python, Node/npm, Git, build tools, ffmpeg, Go, Docker, `ngit`, `nak`, and `act`

The adapter protocol is essentially:

```json
{"type":"execute","identifier":"test1","cmd":"echo","args":["hello from VM"],"stdin":"","env":{}}
{"type":"started"}
{"type":"stdout","data":"hello from VM\n"}
{"type":"completed","exitCode":0,"duration":1}
```

This is well suited to deterministic remote verification:

```bash
git clone <fork-url> repo
cd repo
git checkout <commit>
corepack enable || true
npm ci
npm test
```

Important caveats found during inspection:

- The template currently does not include Nix, Playwright/Chromium, pnpm/bun/yarn, mobile SDKs, or desktop GUI tooling.
- `src/executor.ts` logs environment pairs, which would expose decrypted secret env vars if secrets are passed through the adapter.
- Adapter-side timeout should be stronger. Until then, Loom/openteam jobs should wrap commands with `timeout`.
- Health checks currently include busy VMs, which can misclassify long-running loaded jobs.
- The adapter intentionally has no internal queue. Pool exhaustion should be classified as capacity backpressure, not verification failure.

## Remote Evidence Record

A Loom-backed verification result should be normalized into openteam evidence with fields like:

```text
runner: loom-command
worker: <pubkey>
worker_ad: <kind 10100 event id>
mint: <mint url>
paid_cap: 600 sat
spent: 124 sat
change: 476 sat
commit: <sha>
command: <exact command>
exit_code: 0
stdout: <blossom url>
stderr: <blossom url>
job_event: <kind 5100 event id>
status_event: <kind 30100 event id>
result_event: <kind 5101 event id>
```

This should merge with local evidence in the same policy layer that decides:

- succeeded
- needs review
- failed
- blocked
- PR eligible or not

## Cashu Payment Model

Normal CI triggers do not map directly to Cashu because traditional CI often starts on push and bills later. Loom should instead use a prepaid compute-cap model.

Core idea:

```text
funded job request = authorization to run up to N seconds
```

The trigger is not the git push by itself. The trigger is an openteam/Loom job request that references a commit, branch, PR, or Nostr-git event and carries prepaid ecash.

The Loom timeout calculation is:

```text
timeout_seconds = payment_amount / price_per_second
```

After completion:

```text
change_amount = payment_amount - actual_execution_time * price_per_second
```

This preserves pay-as-you-go UX without accounts, subscriptions, or invoices.

Critical caveat:

Cashu can lock who may spend a token, but it cannot independently prove actual compute seconds. Returning change is honest-worker protocol behavior. Limit risk through small prepayments, trusted workers, reputation, short caps, and retries.

## Payment Trigger Points

For openteam:

```text
worker edits code
openteam has exact commit/branch
local verification is incomplete or remote confidence is useful
openteam selects Loom worker
openteam prepays max budget for that one verification job
Loom result comes back
openteam records remote evidence
```

For CI-like push or PR flows:

```text
git push / Nostr-git PR published
-> CI controller sees it
-> controller publishes payment-required quote or available check
-> payer funds job
-> Loom job runs
-> result is attached as status/evidence
```

Workers should not run unfunded just because a commit appeared.

## Wallet Placement

Use an openteam-controlled local hot wallet, not repo files and not worker prompts.

Recommended local storage:

```text
runtime/wallet/
  encrypted Cashu proofs
  trusted mint list
  per-run reserved budgets
  payment/change ledger
```

Keep only a small operating balance there.

Run records should store metadata only:

- payment id
- mint
- amount
- worker pubkey
- proof hashes
- job event ids
- result event ids
- change metadata

Never put Cashu tokens in logs, prompts, git, or DM text.

Worker side also needs a wallet/vault. A worker should validate and swap received ecash before treating a payment as accepted. If accepting arbitrary mints, it should melt immediately or apply stricter trust policy.

## P2PK And Refunds

Use P2PK-locked tokens to the worker, preferably with a refund path.

The desired payment token shape:

```text
spendable by worker until expiry
refund-spendable by client after expiry
```

This handles non-acceptance, relay loss, and worker downtime better than a permanent worker-only lock.

It does not protect against a malicious worker redeeming and not returning change. That risk should be bounded by prepaid budgets and worker trust/reputation.

## UX Modes

Recommended user-facing payment modes:

### Auto-Pay Within Budget

Best default for openteam:

```text
max per job: 500 sats
max per run: 2,000 sats
trusted workers only
trusted mints only
auto-run remote repo-native checks
ask before browser/long jobs
```

### Approve Quote

For expensive or unknown workers:

```text
Remote verification available:
worker: npub...
capability: node+docker+act
max: 900 sats / 15 min
command: npm test
approve?
```

### Contributor-Funded Checks

For public PRs:

```text
contributor funds Loom verification for their branch
result is attached as signed evidence
maintainer can accept it as lower-trust evidence or rerun with maintainer funds
```

## Suggested Protocol Improvement

The current Loom spec can work with payment in the job request, but a quote/reservation phase would improve UX and reduce stuck-payment edge cases.

Possible future flow:

```text
client asks for capability + timeout estimate
worker returns payment request / accepted mints / expiry
client sends funded job
worker accepts and runs
```

This is not required for a first version because worker advertisements already include price and max duration.

## Overall Direction

The architecture should stay simple:

- openteam detects and provisions what it can locally
- Loom handles remote deterministic verification when local confidence is insufficient
- agentic QA is used as evidence-gathering, not proof
- all results become structured evidence
- orchestration loops stop when confidence cannot increase
- payments are prepaid per job with small capped budgets

The near-term target should be:

```text
local repo-native checks
+ local browser evidence when available
+ remote Loom command evidence
+ explicit evidence policy
= practical confidence without a universal provisioner
```
