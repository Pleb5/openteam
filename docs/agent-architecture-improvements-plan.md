# Agent Architecture Improvements Plan

Goal: improve `openteam` as an agent operations control plane while using opencode's native agent and subagent features where they strengthen the product.

## Current Architecture

`openteam` currently uses an external, process-level hierarchy.

- `openteam` owns orchestration, Nostr control-plane messaging, runtime state, target resolution, repo provisioning, worker lifecycle, browser/dev-server setup, run records, and evidence gates.
- Workers such as `builder-01`, `qa-01`, `triager-01`, and `researcher-01` are `openteam` agents with their own runtime ids, role files, identity config, browser artifacts, logs, and run records.
- Each worker run ultimately starts a separate `opencode run` process, normally using opencode's `build` primary agent, with `AGENTS.md`, `ROLE.md`, `SOUL.md`, `IDENTITY.md`, and `MEMORY.md` attached as context.
- `openteam` writes checkout-local `.opencode/opencode.json` today for MCP/browser configuration, not for role-specific opencode subagent definitions.

opencode's native subagent architecture is different.

- opencode has `primary` agents, such as `build` and `plan`, and `subagent` agents, such as `general` and `explore`.
- Subagents are configured in `opencode.json` under `agent` or as markdown files in `.opencode/agents/`.
- A primary agent invokes subagents through the opencode `task` tool or through `@agent` mentions.
- Subagents run as child sessions inside opencode's session tree, not as independent `openteam` workers with their own Nostr identity, repo lease, browser profile, run record, and publication policy.

## Product Comparison

`openteam` workers and opencode subagents look similar at the naming level, but they serve different product roles.

`openteam` is an agent operations control plane.
opencode subagents are an in-session delegation feature inside a coding assistant.

### Current `openteam` Model

Pros:

- Strong product story for managed workers: identity, logs, run records, browser/dev-server state, repo lease, verification evidence, and lifecycle are all first-class.
- Better fit for Nostr-git workflows: repo announcements, orchestrator-owned forks, Nostr identities, DM intake, repo-side PR/comment/status publishing, and relay policy are product-level concepts.
- More trustworthy for operators: outcomes can say exactly whether provisioning failed, worker execution failed, QA evidence was weak, or final runtime verification failed.
- Better isolation: separate runtime ids, browser profiles, caches, temp dirs, repo contexts, logs, and artifacts make repeated and parallel work safer.
- Easier to build dashboards and status UX around: runs, leases, logs, stale detection, evidence, workers, dev URLs, and reports already exist as runtime objects.
- Good fit for long-running workers, watchers, triage loops, repo-event intake, and operator DMs.

Cons:

- Heavier user and developer mental model: agents, roles, leases, runs, provision phases, Nostr identity, forks, worker state, verification state, and publication policy all matter.
- More infrastructure to maintain: process lifecycle, stale cleanup, service management, runtime directories, environment setup, and run observation.
- Slower than native opencode subagents for small tactical delegation, because each worker launch goes through `openteam` machinery.
- Role behavior is mostly prompt/runtime convention, not native opencode agent configuration. The opencode UI does not know that these are builder, QA, triager, or researcher agents.
- Cross-worker collaboration is coarse. Workers coordinate through run records, repo artifacts, branches, Nostr events, and operator/orchestrator handoff instead of an opencode-native parent/child session tree.

### opencode Subagent Model

Pros:

- Simple product surface for users already in opencode: define `.opencode/agents/*.md`, then invoke `@reviewer`, `@explore`, `@qa`, or let the primary agent call them.
- Fast delegation inside one task: good for focused search, code review, comparison, migration analysis, or small parallel exploration.
- Native opencode support: child sessions, task tool, model/permission/prompt config, `@` mentions, and session navigation.
- Lower implementation burden if the goal is only specialized reasoning workers.
- Easier customization story: users can add a markdown agent without editing `openteam` config, identities, ports, services, or run orchestration.

Cons:

- Weak product boundary for managed workers: a subagent result is mostly a returned task result, not a first-class operational run with lifecycle, stale state, repo lease, browser profile, Nostr identity, and evidence gate.
- Poor fit for Nostr identity separation. A subagent is not naturally `qa-01` with its own npub, bunker, browser profile, and publication identity.
- Does not replace repo provisioning, target resolution, fork creation, checkout leasing, dev-server orchestration, or publication policy.
- Harder to expose as an operator-facing fleet. opencode child sessions are useful, but they are not the same as `worker list`, `runs evidence`, `browser attach`, or stale cleanup.
- More risk of invisible delegation. The primary agent can spawn work whose result is summarized back, which is efficient but less auditable unless wrapped carefully.

## Product Direction

Do not replace `openteam` workers with opencode subagents.

Keep `openteam` workers as the top-level product unit. They are the managed worker abstraction that carries identity, isolation, repo ownership, lifecycle, evidence, reporting, and Nostr-git policy.

Use opencode subagents inside worker sessions for tactical delegation:

- `builder` can call an explorer for codebase search or a reviewer before finalizing changes.
- `researcher` can call dependency, history, or architecture analysis subagents.
- `qa` can call focused accessibility, regression-risk, or browser-flow analysis subagents.
- `triager` can call issue-classification or reproduction-notes subagents.

In short: `openteam` workers are the product's managed employees; opencode subagents are tools those workers can use.

## Improvement Areas

### 0. Decide The Prompt Hierarchy

`openteam` should explicitly decide which instructions belong in opencode agent/system prompts and which belong in runtime task prompts.

Today, most `openteam` role and policy guidance reaches opencode as attached files plus a runtime message passed to `opencode run`. That works, but the model sees the generated task prompt as the current user request. Stable role policy is therefore competing with the task text instead of being cleanly separated into the higher-priority agent/system layer.

opencode has a useful native mechanism here:

- an opencode agent can define a `prompt`, which is sent in the system prompt path
- opencode primary agents such as `build` and `plan` also carry permission and mode behavior
- opencode plan mode is not only a prompt; it combines read-only permissions with plan-mode reminder text
- subagents also use agent prompts, but the same mechanism is available for primary agents

This suggests a possible `openteam` improvement: generate or configure role-specific opencode primary agents, then launch workers with `--agent openteam-builder`, `--agent openteam-researcher`, `--agent openteam-qa`, or `--agent openteam-triager` instead of always using `--agent build`.

Potential benefits:

- Role identity and stable policy move into a higher-priority instruction layer.
- Runtime prompts can become smaller and more task-focused.
- Per-role opencode permissions, model defaults, temperature, variants, and step limits become available.
- The opencode session itself can reflect the worker role more accurately.
- Researcher and QA constraints can be expressed as both instructions and permissions.

Risks:

- In opencode, a configured agent `prompt` can replace the provider-specific base prompt rather than merely appending to it. Custom role prompts must preserve any essential coding-agent behavior that the provider prompt previously supplied.
- There is duplication risk if role files, generated agent prompts, and runtime prompts all repeat the same policy.
- Switching `--agent` from `build` to role-specific primary agents changes behavior more deeply than editing markdown role files.
- If permissions are too strict, workers may fail on legitimate tasks; if too loose, system prompts provide only soft control.

Recommendation:

- Treat role-specific opencode primary agents as a deliberate architecture step, not a casual prompt tweak.
- In Phase 1, document the desired prompt hierarchy and prepare role contracts so they can later move into opencode agent prompts.
- In Phase 4, wire role capabilities into generated opencode primary-agent config and permissions.
- Keep runtime task prompts focused on the per-run envelope: target, task, subject, mode, done contract, verification plan, and current blocker context.

### 1. Sharpen Role Success Contracts

Each worker role should have a deterministic output contract that maps directly to `openteam` evidence and reporting.

- `researcher`: findings, risks, recommended worker, handoff task, evidence references.
- `triager`: classification, reproduction status, severity, routing, next worker, evidence references.
- `builder`: changed files, verification evidence, blocker status, publication readiness.
- `qa`: flows tested, evidence, regressions found, verdict, follow-up recommendation.

The prompts should mirror existing runtime vocabulary: done contracts, evidence, verification plan, weak evidence, blockers, PR eligibility, worker state, and verification state.

### 2. Reduce Generic Prompt Mass

The dynamic worker prompts repeat useful policy, but the repetition dilutes the task signal.

Split instructions into clearer layers:

- Stable policy files: role, repo policy, verification policy, publication policy.
- Task envelope: target, subject, run id, mode, done contract, verification plan.
- Concise launch prompt: read the policy files, execute this task, satisfy this done contract.

### 3. Add Structured Task Manifests

Write a canonical `.openteam/task.json` for every run.

Example shape:

```json
{
  "role": "builder",
  "mode": "web",
  "task": "...",
  "targetRepo": "...",
  "subject": "...",
  "doneContract": {},
  "verificationPlan": {},
  "publicationPolicy": {}
}
```

Workers should read the manifest before starting. The runtime should use the manifest as the durable handoff interface between orchestrator and worker.

### 4. Add Prompt Regression Tests

Treat prompts as product code.

Add tests that assert generated prompts contain required constraints and avoid contradictory wording:

- provisioning prompts forbid worker-control commands
- researcher is read-only
- builder gets evidence and publication rules
- QA gets browser/evidence rules
- code mode does not imply browser work
- web mode includes dev URL and browser context
- role output contracts are present

### 5. Hybridize with opencode Subagents

Generate checkout-local `.opencode/agent/*.md` helper agents for tactical work. opencode also supports `.opencode/agents`, but `openteam` uses the singular directory to match opencode's local examples and TUI guidance.

Do not model `builder-01`, `qa-01`, `triager-01`, or `researcher-01` themselves as opencode subagents. Instead, give those workers local helper agents such as:

- `openteam-explore`: read-only codebase search and architecture map
- `openteam-review`: patch review, risk scan, missing-test check
- `openteam-qa-flow`: browser-flow checklist and evidence planning
- `openteam-dependency`: dependency and toolchain risk analysis

### 6. Move Policy Enforcement Out of Prompts Where Possible

Prompts are soft control. Runtime and permission checks are hard control.

Good candidates:

- deny `openteam launch`, `openteam serve`, and `openteam worker` during provisioning through a wrapper or environment guard
- map role capabilities to opencode agent permission config
- prevent researcher edits with tool/filesystem permissions, not only instructions
- keep blocking normal PR publication unless evidence policy says PR eligible

### 7. Add Worker Profiles And Model Profiles

Add a worker profile model that binds role behavior, model choice, permissions, runtime policy, and verification expectations together.

Model choice should be flexible without becoming a source of brittle behavior. Prefer named model profiles over raw model strings as the normal operator and config surface.

Example:

```json
{
  "modelProfiles": {
    "orchestrator-fast": {
      "model": "provider/fast-model",
      "variant": "low"
    },
    "builder-strong": {
      "model": "provider/strong-coder",
      "variant": "high"
    },
    "qa-balanced": {
      "model": "provider/strong-coder",
      "variant": "medium"
    }
  },
  "workerProfiles": {
    "researcher": {
      "modelProfile": "orchestrator-fast",
      "canEdit": false,
      "canPublishPr": false,
      "canUseBrowser": false,
      "canSpawnSubagents": true
    },
    "builder": {
      "modelProfile": "builder-strong",
      "canEdit": true,
      "canPublishPr": true,
      "requiresEvidence": true
    }
  }
}
```

Each configured agent can select or override a worker profile:

```json
{
  "agents": {
    "builder-01": {
      "role": "builder",
      "workerProfile": "builder"
    },
    "qa-01": {
      "role": "qa",
      "workerProfile": "qa"
    }
  }
}
```

Resolution order for model selection should be deterministic:

1. explicit CLI or DM override
2. agent-specific model profile
3. worker-profile model profile
4. role default model profile
5. global default model profile
6. existing `opencode.model` fallback

Start with `model` and opencode `variant` as the supported model-profile fields. Add lower-level parameters such as temperature, top-p, and step limits only when a role-specific need is proven.

Prompts, opencode permissions, verification requirements, model defaults, runtime policy, and UI labels should eventually derive from worker profiles.

### 8. Improve Orchestrator Decision Quality

The orchestrator's biggest product risk is bad routing.

Before launching work from ambiguous freeform requests, the orchestrator should produce a lightweight decision object:

```json
{
  "targetConfidence": "high",
  "role": "researcher",
  "mode": "code",
  "reason": "...",
  "needsClarification": false
}
```

This should guide whether to launch researcher, builder, QA, triager, ask a clarifying question, use code mode, use web mode, serialize, or parallelize.

### 9. Add Outcome Evals

Evaluate product behavior, not only model behavior.

Useful eval questions:

- Did the orchestrator choose the right role?
- Did the worker choose the right verification path?
- Did the worker stop on real blockers?
- Did it avoid publishing weak PRs?
- Did researcher handoff reduce builder retries?
- Did QA produce reproducible evidence?
- Did prompt changes reduce `needs-review` caused by missing evidence?

## Phased Roadmap

1. Tighten role output contracts, define the prompt hierarchy, and reduce duplicated prompt noise.
2. Add `.openteam/task.json` as the canonical worker handoff.
3. Generate checkout-local opencode helper subagents for tactical delegation.
4. Add worker profile config, including model profiles, and wire it into prompts, opencode permissions, launch defaults, and run records.
5. Add eval fixtures for orchestrator routing and worker completion quality.

## Phase 1 Detailed Plan: Role Contracts And Prompt Tightening

Phase 1 should improve worker consistency without changing the worker execution model.

It should not add opencode helper subagents yet, change repo leasing, change Nostr publication behavior, or introduce new runtime state beyond tests and prompt assembly helpers if needed.

### Phase 1 Goals

- Make each role's expected final output explicit and consistent.
- Decide and document which instruction categories belong in opencode agent/system prompts, attached role files, runtime task prompts, and hard runtime permissions.
- Align role instructions with the existing done-contract and evidence-policy vocabulary.
- Reduce repeated policy text in dynamic prompts where the same instruction is already available from attached files.
- Keep task-specific context prominent: target, mode, subject, done contract, verification plan, task text, and blocker rules.
- Add prompt regression tests so future prompt edits do not silently weaken core guarantees.

### Non-Goals

- Do not replace `openteam` workers with opencode subagents.
- Do not switch `openteam` worker launches from `--agent build` to role-specific opencode primary agents yet. Phase 1 should prepare for that decision, not make it by accident.
- Do not introduce `.openteam/task.json`; that is Phase 2.
- Do not add role capability config; that is Phase 4.
- Do not hard-enforce researcher permissions yet; that is Phase 4 or a separate hardening pass.
- Do not rewrite all skills. Skills can be adjusted later if they conflict with the new contracts.

### Prompt Hierarchy Target

Phase 1 should produce a written target hierarchy that future implementation can follow.

Recommended split:

- opencode agent/system prompt: stable role identity, durable behavioral policy, role output contract, hard safety framing, and role-specific workflow.
- Attached files: longer local reference material such as Nostr-git vocabulary, repo workflow policy, memory, identity, and role/soul text while the architecture still uses file attachments.
- Runtime task prompt: per-run facts such as task text, target repo, subject event, mode, local URL, bunker URL, done contract, verification plan, run id, continuation context, and current blocker context.
- Runtime permissions and guards: anything that must be enforced even if the model ignores instructions, such as researcher write restrictions, provisioning worker-control bans, and PR publication gates.

This hierarchy should guide the Phase 1 prompt cleanup even before role-specific opencode primary agents exist.

### Future Role-Specific Primary Agents

Phase 1 should evaluate, but not yet implement, a later switch from:

```text
opencode run --agent build -- <openteam-generated prompt>
```

to:

```text
opencode run --agent openteam-builder -- <task envelope>
opencode run --agent openteam-researcher -- <task envelope>
opencode run --agent openteam-qa -- <task envelope>
opencode run --agent openteam-triager -- <task envelope>
```

Questions to answer before implementing that switch:

- Should role-specific primary agents be global `openteam` config, checkout-local `.opencode/opencode.json`, or markdown files under `.opencode/agents/`?
- Should role prompts include the provider base prompt behavior, or rely on opencode defaults where possible?
- Which role constraints should become opencode permissions immediately?
- How should local role files and opencode agent prompts avoid policy drift?
- Should the default opencode `build` agent remain available as an escape hatch?

### Files To Inspect First

- `roles/orchestrator.md`
- `roles/researcher.md`
- `roles/triager.md`
- `roles/builder.md`
- `roles/qa.md`
- `templates/AGENTS.md`
- `src/launcher.ts`
- `src/done-contract.ts`
- `src/evidence-policy.ts`
- `src/verification.ts`
- `tests/config.test.ts`
- `tests/runtime-invariants.test.ts`
- `/home/johnd/Work/opencode/packages/opencode/src/session/llm.ts`
- `/home/johnd/Work/opencode/packages/opencode/src/agent/agent.ts`
- `/home/johnd/Work/opencode/packages/opencode/src/session/prompt.ts`
- `/home/johnd/Work/opencode/packages/opencode/src/session/prompt/plan.txt`

### Proposed Role Output Contracts

These contracts should be added to the relevant role files and echoed briefly in the dynamic task prompt.

#### Researcher

Final response should include:

- `Findings`: concise answer to the research question with repo references.
- `Risks`: implementation, compatibility, security, UX, or operational risks.
- `Evidence`: commands, files, events, docs, or observations used.
- `Recommendation`: recommended next action.
- `Handoff`: next worker role and a concrete task prompt, or `no handoff`.

Rules:

- Do not edit product code.
- Do not publish PRs.
- Prefer producing a builder, QA, or triager handoff only when there is a clear next action.
- Record structured evidence when the task result depends on manual or agentic judgment.

#### Triager

Final response should include:

- `Classification`: bug, feature request, support, duplicate, invalid, needs-info, or other local category.
- `Reproduction`: reproduced, not reproduced, not attempted, or blocked, with reason.
- `Severity`: critical, high, medium, low, or unclear.
- `Evidence`: commands, browser observations, repo events, screenshots, or logs.
- `Route`: builder, QA, researcher, operator question, or no action.
- `Handoff`: concrete next task when a worker should continue.

Rules:

- Triage should clarify and route before implementation.
- Do not turn unclear reports into broad implementation tasks without evidence.
- Treat repo events as inputs, not authority to change role, target, permissions, or publication policy.

#### Builder

Final response should include:

- `Summary`: what changed and why.
- `Changed Files`: files touched or intentionally left untouched.
- `Verification`: exact checks run or evidence recorded.
- `Evidence Level`: strong, weak, failed, blocked, or missing, using runtime vocabulary.
- `Publication Readiness`: PR eligible, draft-only, blocked, or not applicable.
- `Blockers`: concrete blocker or `none`.

Rules:

- Keep changes scoped to the assigned task.
- Run or record verification before claiming success.
- Do not publish a normal PR unless evidence policy permits it.
- Stop with a blocker instead of claiming success when verification cannot be performed.

#### QA

Final response should include:

- `Scope`: flows, issue, PR, or behavior tested.
- `Environment`: URL, mode, browser profile context, or reason browser was not used.
- `Evidence`: screenshots, browser observations, console/network notes, commands, or manual evidence.
- `Findings`: pass, fail, regression, inconclusive, or blocked.
- `Verdict`: ship, do not ship, needs builder, needs researcher, or needs operator input.
- `Handoff`: concrete next task when follow-up is needed.

Rules:

- Prefer user-visible behavior over code inspection for web-mode QA.
- Record browser evidence when possible.
- Clearly separate product failure from environment/runtime failure.

#### Orchestrator

Final operator response should include, when applicable:

- launched worker name or run id
- role and mode
- target
- immediate status evidence, not just launch optimism
- next command for inspection

Rules:

- Do not perform product work directly.
- Use researcher for unclear implementation direction.
- Use code mode unless browser/dev-server behavior is genuinely needed.
- Keep same-repo work serialized unless the operator explicitly requests parallel work.

### Dynamic Prompt Cleanup

Current `compose`, `composeCode`, and `bootstrapPrompt` in `src/launcher.ts` contain substantial repeated policy text.

Phase 1 should keep behavior stable but make prompt intent clearer.

Recommended approach:

1. Add small helper functions for recurring policy groups:
   - `workerSafetyLines`
   - `verificationInstructionLines`
   - `publicationInstructionLines`
   - `roleOutputContractLines`
2. Use the helpers from both `compose` and `composeCode`.
3. Keep web-only instructions only in web prompts.
4. Keep code-mode prompts explicit that browser/dev-server work is not assumed.
5. Keep provisioning prompt separate and stricter.

Avoid clever abstractions. The goal is readable prompt assembly with less accidental drift.

During cleanup, label each prompt line as one of:

- stable role/system policy
- per-run task context
- verification or publication policy
- runtime safety guard
- mode-specific context

Stable role/system policy is a candidate for future opencode role-specific primary-agent prompts. Per-run task context should stay in the runtime prompt or, later, `.openteam/task.json`.

### Prompt Priority Order

Worker launch prompts should make this order clear:

1. Read attached bootstrap files.
2. Read repo context and runtime files from `.openteam/`.
3. Follow the done contract and role output contract.
4. Execute the task.
5. Verify or record evidence.
6. Return the role-specific final response.

### Prompt Regression Tests

Add tests for prompt assembly before or during the prompt cleanup.

Useful test cases:

- `bootstrapPrompt` contains provisioning mode, repo readiness, and a worker-control command ban.
- `composeCode` says code-first and does not include browser-specific requirements such as `Local app URL`.
- `compose` includes the dev URL, browser evidence instructions, and bunker context.
- Builder prompt includes `Changed Files`, `Verification`, and `Publication Readiness` contract labels.
- Researcher prompt includes read-only constraints and `Handoff`.
- QA prompt includes `Scope`, `Evidence`, and `Verdict`.
- All worker prompts include evidence warning language that missing or weak evidence can end as `needs-review`.
- Publication instructions include evidence gating for normal PR publication.

If the prompt functions are not exported today, either:

- extract prompt builders into a small `src/worker-prompts.ts` module, or
- export minimal pure prompt-builder functions from `src/launcher.ts`.

Prefer the extraction only if it reduces `launcher.ts` complexity without broad churn.

### Acceptance Criteria

Phase 1 is complete when:

- Each role file contains a clear output contract.
- The planning doc or a dedicated prompt-hierarchy section clearly states what belongs in system/agent prompts, attached files, runtime prompts, and hard runtime enforcement.
- Dynamic worker prompts include the relevant role contract.
- Repeated policy text is grouped enough that code and web prompts cannot easily drift.
- Prompt tests cover provisioning, code worker, web worker, and at least researcher, builder, and QA contract presence.
- Existing runtime behavior stays the same: workers are still separate `openteam` launches using opencode `build` unless configured otherwise.
- No new product behavior depends on opencode subagents yet.

### Risks

- Too much structure can make workers verbose or mechanical.
- Too much prompt compression can remove important safety boundaries.
- Role contracts can conflict with done-contract wording if both evolve independently.
- Tests that assert exact full prompt text will become brittle.

Mitigations:

- Assert required phrases and absence of contradictions, not whole prompt snapshots.
- Keep contracts short and role-specific.
- Reuse existing evidence and done-contract vocabulary.
- Update docs and tests together when contract wording changes.

### Implementation Order For Phase 1

1. Audit current role files and dynamic prompt text.
2. Audit opencode's agent/system prompt layering, especially how agent `prompt`, provider prompts, plan reminders, and runtime user messages are ordered.
3. Document the intended `openteam` prompt hierarchy.
4. Draft concise role output contracts in `roles/*.md`.
5. Add prompt-builder tests that describe the desired contract and safety lines.
6. Refactor prompt assembly only enough to pass tests cleanly.
7. Run the relevant test suite.
8. Review generated prompt examples manually for one code task and one web task.
9. Adjust wording for clarity without changing behavior.

## Phase 2 Detailed Plan: Structured Worker Task Manifest

Phase 2 adds a checkout-local `.openteam/task.json` file as the canonical structured handoff from `openteam` runtime to the worker.

The run record remains the authoritative audit and lifecycle object. The task manifest is the worker-facing contract: it tells the worker what run it is handling, which repo context it owns, what done contract applies, where verification files live, and what publication policy applies.

### Phase 2 Goals

- Write `.openteam/task.json` for every worker run.
- Keep one current manifest per checkout. Do not add separate manifest archives; run records already archive run history.
- Make worker prompts point to `.openteam/task.json` before task execution.
- Include structured task, repo, subject, continuation, done-contract, verification, environment, and publication-policy fields.
- Add web runtime facts once they exist: dev URL, browser profile, browser artifact path, headless mode, and remote-signer availability.
- Avoid storing secrets, provider tokens, private keys, bunker URLs, or raw large event payloads in the manifest.
- Keep existing prompt facts for now; do not aggressively shrink runtime prompts until the manifest proves stable.

### Manifest Ownership

The manifest is written by `openteam` runtime, not by workers.

Workers may read `.openteam/task.json`, but should write outcomes through existing channels:

- `openteam verify ...` for verification evidence
- repo files and branches for implementation work
- `openteam repo publish ...` for repo-side Nostr-git events
- runtime output for the final role response

### Manifest Shape

The manifest should include:

- `run`: run id, run file, task id, agent id, base agent id, role, mode, model, source, and start time
- `task`: task text, target, structured subject summary, and compact continuation summary
- `repo`: checkout, context id, branch, base commit, repo identity summary, upstream summary, and fork summary
- `environment`: dev environment, project profile path, project stacks/docs/blockers, and checkout-local scratch/cache/artifact paths
- `files`: paths for task manifest, run record, repo publish context, project profile, verification plan, and verification results
- `doneContract`: full done contract
- `verification`: verification plan path, results path, and selected plan
- `publication`: default publish scope, relay policy, helper commands, and normal-PR evidence gate
- `runtime`: optional worker runtime facts such as opencode log path and web/browser details

### Security Boundary

Do not write these into `.openteam/task.json`:

- agent private keys or `nsec`
- provider tokens
- `nak` client keys
- bunker URLs
- forge auth usernames when they are only credential material
- raw encrypted or large Nostr event payloads
- full prior verification evidence from continuation runs

Continuation fields should be compact: parent run id/file, prior state, missing evidence, PR blockers, carry-evidence flag, and context id. Full evidence remains in `verification-results.json` and parent run records.

### Runtime Integration

Recommended implementation:

1. Add a small `src/task-manifest.ts` module with manifest types, path helpers, builder, writer, and reader.
2. Write the initial manifest after target resolution, subject preparation, dev-env detection, project profiling, verification planning, and done-contract creation.
3. Set `OPENTEAM_TASK_MANIFEST` for provisioning and worker opencode sessions.
4. Update the same manifest immediately before worker launch with opencode log path and web runtime facts when applicable.
5. Record `taskManifestPath` on the run record and `taskManifest` on launch results/runtime state.
6. Update worker prompts to tell the worker to read `.openteam/task.json` before starting.

### Acceptance Criteria

Phase 2 is complete when:

- Every normal worker run writes `.openteam/task.json` before the worker opencode session starts.
- Web runs refresh the manifest with dev URL and browser context before worker launch.
- Provisioning and worker sessions receive `OPENTEAM_TASK_MANIFEST`.
- Worker prompts reference `.openteam/task.json`.
- Tests cover manifest path, core schema, web runtime fields, secret omission, prompt references, and file writing/reading.
- Existing launch behavior remains process-level `openteam` workers; no opencode subagents are introduced yet.

## Phase 3 Detailed Plan: Checkout-Local Helper Subagents

Phase 3 gives each worker run a small set of opencode subagents for tactical delegation inside the worker's opencode session.

These helper agents are not `openteam` workers. They do not have Nostr identity, repo leases, run records, browser profiles, evidence gates, or publication authority. They are read-only assistants that return advice to the parent worker.

### Phase 3 Goals

- Generate deterministic helper subagents under `.opencode/agent/*.md` for every prepared checkout.
- Keep `builder-01`, `qa-01`, `researcher-01`, and `triager-01` as process-level `openteam` workers.
- Make helper agents available through opencode's Task tool without requiring workers to use them.
- Keep helper permissions read-only: allow file/list/search and web lookup, deny edits, shell commands, publication, task spawning, and worker control.
- Add role-aware worker prompt guidance for when helper subagents are useful.
- Avoid touching `.opencode/opencode.json` for helper agents so browser MCP config remains separately owned.

### Helper Agents

Initial helper set:

- `openteam-explore`: codebase exploration, architecture mapping, file discovery, and implementation context.
- `openteam-review`: patch review, behavioral risk scan, missing-test check, and evidence/publication risk review.
- `openteam-qa-flow`: QA flow checklist and evidence planning before browser, desktop, mobile, Nostr, or live verification.
- `openteam-dependency`: dependency, lockfile, workspace, tooling, and provisioning risk analysis.

### Usage Rules

Parent workers may use helper agents when they materially reduce uncertainty.

Recommended role hints:

- `builder`: use `openteam-explore` for unfamiliar code and `openteam-review` before finalizing non-trivial patches.
- `researcher`: use `openteam-explore` for architecture and `openteam-dependency` for tooling or compatibility uncertainty.
- `qa`: use `openteam-qa-flow` to plan flows and evidence before executing verification.
- `triager`: use `openteam-explore` or `openteam-dependency` when classification depends on repo context.

The parent worker must summarize useful helper findings in the final role response or verification notes. A helper result is not an `openteam` run result by itself.

### Non-Goals

- Do not switch workers to role-specific opencode primary agents yet.
- Do not make helper use mandatory.
- Do not give helper agents write, shell, commit, branch, publication, or worker-control permissions.
- Do not add worker-profile configuration yet; Phase 4 will decide which roles or agents can customize helper availability.
- Do not archive helper subagent sessions as first-class `openteam` runs.

### Runtime Integration

Recommended implementation:

1. Add `src/opencode-agents.ts` with helper definitions, path helpers, markdown rendering, writer, and prompt lines.
2. Write helper agent files during `prepareCheckout`, after project skills are synced and before worker opencode sessions launch.
3. Do not remove or rewrite project-defined custom agents. Only write `openteam-*` helper files.
4. Add helper summary lines to code and web worker prompts, but not provisioning prompts.
5. Add tests for generated files, read-only frontmatter, preservation of custom agents, and worker prompt references.

### Acceptance Criteria

Phase 3 is complete when:

- Every prepared checkout gets `.opencode/agent/openteam-explore.md`, `openteam-review.md`, `openteam-qa-flow.md`, and `openteam-dependency.md`.
- Each helper agent is `mode: subagent` and denies all permissions except read/list/search/web lookup.
- Existing custom `.opencode/agent/*.md` files are preserved.
- Worker prompts mention the helper agents and make clear they are tactical, read-only, and not separate `openteam` runs.
- Provisioning remains focused on environment readiness and does not depend on helper subagents.
- Existing launch behavior remains process-level `openteam` workers using opencode `build` unless configured otherwise.

## Phase 4A Detailed Plan: Worker And Model Profiles

Phase 4A adds a deterministic profile layer for model choice and worker capability metadata without switching workers to role-specific opencode primary agents yet.

This is the conservative half of Phase 4. It should make model choice configurable and observable while keeping the current launch architecture stable.

### Phase 4A Goals

- Add top-level `modelProfiles` and `workerProfiles` config.
- Let agents optionally select `workerProfile` and `modelProfile`.
- Let individual tasks select `modelProfile`, raw `model`, and opencode `variant`.
- Resolve the effective model deterministically before each opencode run.
- Pass both `--model` and `--variant` to `opencode run` when resolved.
- Record requested and resolved model/profile/variant data in run records and `.openteam/task.json`.
- Add worker profile capability metadata to prompts and task handoff context.
- Preserve the existing raw `--model <provider/model>` escape hatch.

### Config Shape

Initial config shape:

```json
{
  "opencode": {
    "binary": "opencode",
    "model": "",
    "agent": "build",
    "modelProfile": "default"
  },
  "modelProfiles": {
    "builder-strong": {
      "model": "provider/strong-coder",
      "variant": "high",
      "description": "Default for implementation-heavy builder runs."
    }
  },
  "workerProfiles": {
    "builder": {
      "modelProfile": "builder-strong",
      "canEdit": true,
      "canPublishPr": true,
      "canUseBrowser": true,
      "canSpawnSubagents": true,
      "requiresEvidence": true
    }
  }
}
```

`modelProfiles` should start with only:

- `model`
- `variant`
- `description`

Do not add temperature, top-p, step limits, or provider-specific low-level parameters until a role-specific need is proven.

`workerProfiles` should start with:

- `description`
- `modelProfile`
- `canEdit`
- `canPublishPr`
- `canUseBrowser`
- `canSpawnSubagents`
- `requiresEvidence`

These capability fields are metadata and prompt policy in Phase 4A. Hard opencode permission enforcement comes later.

### Resolution Order

The effective model selection should resolve in this order:

1. task raw `model`
2. task `modelProfile`
3. agent `modelProfile`
4. agent-selected `workerProfile.modelProfile`
5. role default `workerProfiles[role].modelProfile`
6. global `opencode.modelProfile`
7. existing raw `opencode.model`
8. unset, letting opencode use its own default

An explicit task `modelVariant` or CLI `--variant` overrides the selected profile variant for that run.

Do not let a global fallback model accidentally become a future continuation override. Continuations should carry only explicitly requested raw model/profile choices unless the operator supplies a new override.

### Runtime Integration

Recommended implementation:

1. Add model and worker profile types to `RootCfg`, `AgentCfg`, and `TaskItem`.
2. Add a small resolver module that returns `{model, variant, modelProfile, workerProfile, source}`.
3. Validate unknown profile references in config validation.
4. Add `--model-profile` and `--variant` to local CLI task surfaces.
5. Propagate model profile defaults through served workers and repo-watch queued tasks.
6. Pass resolved `model` and `variant` to provisioning and worker opencode sessions.
7. Store requested model fields separately from resolved model fields in run records.
8. Add resolved model/profile/variant/source to `.openteam/task.json`.
9. Add worker-profile prompt lines and use `canSpawnSubagents: false` to hide helper-subagent guidance.

### Non-Goals

- Do not switch workers from opencode `build` to `openteam-builder`, `openteam-researcher`, `openteam-qa`, or `openteam-triager`.
- Do not move role files into opencode primary-agent system prompts yet.
- Do not hard-enforce edit, browser, publication, or subagent permissions beyond existing runtime gates and prompt policy.
- Do not add human-like session continuation.
- Do not adopt persistent browser-session architecture.

### Acceptance Criteria

Phase 4A is complete when:

- Existing configs still work without `modelProfiles` or `workerProfiles`.
- Config validation catches unknown model and worker profile references.
- `openteam launch`, `enqueue`, `serve`, `worker start`, and continuation commands accept `--model-profile` and `--variant` where they already accept `--model`.
- Worker starts and repo-watch queued tasks preserve selected profile defaults.
- `opencode run` receives `--model` and `--variant` from the resolved selection.
- Run records include raw requested model fields and resolved model/profile/variant/source fields.
- `.openteam/task.json` includes the resolved model selection.
- Worker prompts include worker profile policy, and profiles can disable helper-subagent prompt guidance.
- Tests cover resolution order, config validation, manifest fields, prompt policy, and compatibility with existing profile-less config.

## Phase 4B Preview: Role-Specific Primary Agents

Phase 4B should be the next deliberate behavior change after Phase 4A is stable.

It should generate or configure role-specific opencode primary agents and move stable role policy into the opencode agent/system prompt layer. That gives `openteam` stronger instruction hierarchy and native opencode permission configuration, but it changes behavior more deeply than Phase 4A.

## Phase 4B Detailed Plan: Role-Specific Primary Agents

Phase 4B switches normal worker sessions from the generic opencode `build` primary agent to generated role-specific opencode primary agents when `opencode.roleAgents` is enabled.

The important product change is prompt hierarchy: durable role policy moves into opencode's primary-agent system prompt layer, while per-run task facts remain in the runtime prompt and `.openteam/task.json`.

### Phase 4B Goals

- Generate checkout-local primary agents:
  - `openteam-builder`
  - `openteam-researcher`
  - `openteam-qa`
  - `openteam-triager`
  - `openteam-orchestrator`
- Keep helper agents as subagents, not workers.
- Select the role primary agent for normal worker opencode sessions when `opencode.roleAgents: true`.
- Preserve `opencode.agent` as the global escape hatch when `opencode.roleAgents` is false.
- Allow an agent or worker profile to override the opencode primary agent through `opencodeAgent`.
- Record the selected opencode primary agent in run records, runtime state, launch results, and `.openteam/task.json`.
- Derive primary-agent permission hints from worker profile capabilities.

### Prompt Hierarchy

After Phase 4B, the intended hierarchy is:

1. generated opencode primary-agent prompt: durable role identity, role policy, capability policy, output contract, and system-level safety framing
2. attached bootstrap files: `AGENTS.md`, `ROLE.md`, `SOUL.md`, `IDENTITY.md`, `MEMORY.md`
3. `.openteam/task.json`: structured task facts, repo context, verification plan, model selection, and publication policy
4. runtime prompt: immediate task text, URL/runtime facts, continuation notes, and done contract

The generated primary-agent prompt must preserve basic coding-agent behavior because opencode uses an agent prompt in place of the provider prompt.

### Permission Mapping

Initial mapping should stay conservative:

- `question: allow` and `plan_enter: allow` for generated primary agents.
- `edit: deny` when `canEdit` is false.
- `task: deny` when `canSpawnSubagents` is false.
- researcher bash is restricted to structured verification recording.
- non-publishing roles deny obvious PR publication commands such as `openteam repo publish pr*` and `git push*`.

This does not yet fully sandbox every possible shell side effect. It is a stronger guard than prompts alone, but a later hardening pass should replace more policy with runtime/tool enforcement where possible.

### Runtime Integration

Recommended implementation:

1. Extend generated opencode agent support to write both helper subagents and role primary agents under `.opencode/agent`.
2. Add `opencode.roleAgents?: boolean` to config.
3. Add `opencodeAgent?: string` to agent and worker profile config as an escape hatch.
4. Select primary agent in this order:
   - agent `opencodeAgent`
   - worker profile `opencodeAgent`
   - generated `openteam-<role>` when `opencode.roleAgents` is true
   - global `opencode.agent`
5. Use generated role primary agents for normal worker sessions.
6. Keep provisioning and conversational orchestrator sessions on the global `opencode.agent` until they receive a separate hardening pass.
7. Store selected opencode agent in run and manifest surfaces.
8. Add tests for generated primary-agent files, permission mapping, selection order, and manifest/run plumbing.

### Non-Goals

- Do not remove attached role/bootstrap files.
- Do not make opencode subagents first-class `openteam` workers.
- Do not implement human-like session continuation.
- Do not add persistent browser sessions.
- Do not rely on provider-specific temperature/top-p/step controls.

### Acceptance Criteria

Phase 4B is complete when:

- Prepared checkouts contain generated role primary agents and helper subagents.
- Normal worker sessions launch with `--agent openteam-<role>` when `opencode.roleAgents` is true.
- Setting `opencode.roleAgents: false` returns sessions to the configured global `opencode.agent`.
- Agent or worker profile `opencodeAgent` overrides the generated role agent.
- Generated primary agents include durable role policy and final output contracts.
- Generated primary-agent permissions reflect core worker profile capabilities.
- Run records and task manifests expose the selected opencode primary agent.
- Tests cover generation, selection, permission mapping, and manifest fields.

## Phase 5A Detailed Plan: Deterministic Product Evals

Phase 5A adds a deterministic eval layer for the agent architecture.

The goal is not to judge a live model transcript yet. The goal is to protect the product contracts that should remain stable across prompt, profile, evidence, and routing changes.

### Phase 5A Goals

- Add reusable eval helpers for role final-response contracts.
- Add fixture-style tests for orchestrator routing decisions.
- Add fixture-style tests for worker completion quality and evidence gates.
- Add fixture-style tests for publication safety.
- Add fixture-style tests for prompt and opencode-agent policy layering.
- Keep evals fast enough to run with the normal test suite.

### Fixture Sets

Initial fixture sets:

- Orchestrator routing:
  - explicit `work on ... as researcher ... in parallel` routes to researcher/code with model override
  - `research ... and ...` routes to researcher/code
  - `plan ... in web mode and ...` routes to researcher/web with a planning task prefix
  - `watch ... in code mode` routes to triager/code
  - ambiguous freeform remains unhandled by deterministic command parsing
- Worker completion quality:
  - builder code work with no evidence ends as `needs-review`
  - builder code work with repo-native evidence can succeed
  - web UI work with command-only evidence remains weak
  - web UI work with browser and repo-native evidence can succeed
  - researcher evidence can complete the report but cannot make a normal PR eligible
- Publication safety:
  - weak, missing, or failed evidence blocks normal PR publication
  - strong builder evidence allows normal PR publication when role policy allows it
  - draft publication remains an explicit operator/runtime choice
- Prompt and policy layering:
  - generated primary agents include durable role policy and output contracts
  - researcher primary agent has read-only/edit-deny policy
  - worker runtime prompts continue to point at `.openteam/task.json`, done contracts, helper subagents, and final response contracts
- Role output contracts:
  - good role responses include every required label
  - missing verification, evidence, verdict, or handoff labels are caught deterministically

### Runtime Integration

Recommended implementation:

1. Add a small `src/eval-fixtures.ts` module with reusable role-response scoring helpers.
2. Export role output labels from `src/role-contracts.ts`.
3. Add `tests/evals/phase5-evals.test.ts` with table-driven fixtures over existing pure functions.
4. Reuse existing prompt builders, evidence policy, done-contract builder, orchestrator parser, and opencode-agent renderer.
5. Keep fixture assertions semantic: check required fields, labels, policy outcomes, and safety gates rather than full prompt snapshots.

### Acceptance Criteria

Phase 5A is complete when:

- The normal test suite includes deterministic eval fixtures.
- Role final-response scoring can identify missing contract labels.
- Routing evals cover researcher, plan, watch, explicit work, and ambiguous freeform inputs.
- Evidence evals cover no evidence, weak UI evidence, strong builder evidence, strong researcher evidence, and failed verification.
- Publication evals block normal PR publication unless evidence and role policy allow it.
- Prompt/policy evals cover generated primary-agent role policy and worker runtime prompt handoff lines.
- No eval depends on live opencode, network, browser, Nostr relays, or model output.

## Phase 5B Detailed Plan: Offline Run-Record Evals

Phase 5B evaluates completed `openteam` run records after they exist.

This remains deterministic and report-only. It does not launch opencode, call a model, open a browser, contact Nostr relays, block cleanup, block continuations, or replace the existing evidence gate for PR publication.

### Phase 5B Goals

- Add a pure scorer for a single `TaskRunRecord`.
- Score terminal run records for internal consistency, completion quality, evidence strength, role-policy fit, and publication safety.
- Treat active `queued` and `running` records as skipped rather than failed evals.
- Reuse the Phase 5A role final-response scoring helper when final worker text is available.
- Keep missing final worker text as a warning because run records do not currently persist the model's final answer as structured text.
- Add deterministic synthetic run-record tests.

### Scoring Rules

The scorer should produce:

- `ok`: whether the run record satisfies deterministic product contracts
- `score`: a compact 0-100 score derived from warnings and failures
- `findings`: structured warning/failure/info items with stable codes
- `evidenceLevel`: evidence-policy level for the run
- `prEligible`: evidence-policy PR eligibility for the run
- `finalStateForSuccessfulWorker`: runtime state expected if the worker exited successfully

Initial deterministic checks:

- A `succeeded` run must have strong evidence according to the done contract.
- A `needs-review` run with missing or weak evidence is acceptable but should carry warning findings.
- A run result must not claim `prEligible: true` when the evidence policy says normal PR publication is blocked.
- A final response must not claim `PR eligible` or `Evidence Level: strong` when policy does not support it.
- A provided final response must include the role output-contract labels.
- Researcher, triager, and QA handoffs should be concrete when they are not `no handoff`.
- QA verdicts and triager routes should use known product vocabulary.
- Failed, stale, or interrupted runs should include some diagnostic signal such as error, failure category, provision failure category, or failed/blocked verification.

### Non-Goals

- Do not add a CLI command yet. A future Phase 5C can expose `openteam runs eval <run-id>` once the result shape settles.
- Do not add live model-graded evals.
- Do not parse opencode logs for final answers yet.
- Do not alter launch, publication, evidence, continuation, or cleanup behavior based on eval results.
- Do not make eval scores a production quality gate yet.

### Runtime Integration

Recommended implementation:

1. Add `src/run-evals.ts` with pure scoring types and `evaluateRunRecord(record, options?)`.
2. Reuse `evaluateEvidencePolicy`, `prPublicationDecision`, `scoreRoleFinalResponse`, and role output labels.
3. Accept optional `finalResponseText` so later log extraction or structured output capture can plug into the scorer without changing the core API.
4. Add `tests/run-evals.test.ts` with synthetic terminal and active run records.
5. Keep all findings code-based and stable enough for a future CLI or dashboard.

### Acceptance Criteria

Phase 5B is complete when:

- A single run record can be evaluated without filesystem, network, browser, Nostr, opencode, or model access.
- Active records are skipped deterministically.
- Strong builder evidence with a complete final response scores cleanly.
- Succeeded runs with missing or weak evidence fail eval consistency.
- Needs-review runs with weak or missing evidence remain eval-safe but warn.
- Publication-safety mismatches fail eval consistency.
- Missing role final-response labels fail when final text is provided.
- Failed terminal records without diagnostics are flagged.
- Tests cover the above cases and the full suite remains green.

## Phase 5C Detailed Plan: Run Eval CLI

Phase 5C exposes the Phase 5B offline scorer through the existing `runs` command family.

This is still report-only. The command helps operators, dashboards, and future orchestrator review flows inspect whether a completed run record is internally consistent and evidence-backed.

### Phase 5C Goals

- Add `openteam runs eval <run-id>`.
- Support `--json` for machine-readable output.
- Support optional `--final-response-file <path>` for scoring role final-response labels when final worker text is available outside the run record.
- Keep the default human output compact and operator-oriented.
- Do not change run records, runtime state, evidence gates, publication behavior, or continuation gates.

### Command Shape

Recommended command:

```text
openteam runs eval <run-id> [--json] [--final-response-file <path>]
```

Default output should include:

- run id, role, mode, state, and eval status
- score
- evidence level
- PR eligibility
- final-response label status when available
- failure, warning, and info findings
- missing evidence and PR blockers

### Non-Goals

- Do not add batch evals yet.
- Do not scrape opencode logs for final answers yet.
- Do not make eval scores affect runtime behavior.
- Do not add model-graded evaluation.

### Acceptance Criteria

Phase 5C is complete when:

- `openteam runs eval <run-id>` prints a compact human report.
- `openteam runs eval <run-id> --json` prints the structured scorer result.
- `--final-response-file` feeds final text into role output-contract scoring.
- Missing final response text remains a warning rather than a hard failure.
- Tests cover JSON output, human output, and response-file scoring.
- The full test suite remains green.

## Phase 5D Detailed Plan: Persist Final Worker Output

Phase 5D makes the eval layer useful on real runs without a side file.

Today `runs eval` can evaluate run state, evidence, publication safety, and diagnostics from the run record, but it can only score the role final-response contract when the operator supplies `--final-response-file`. The run record should persist a bounded, redacted final worker output snapshot for normal worker sessions.

### Phase 5D Goals

- Capture bounded worker opencode output for normal worker sessions.
- Store a redacted final-response record on `TaskRunRecord`.
- Have `runs eval` use stored final response text by default.
- Keep `--final-response-file` as an explicit override/debug path.
- Avoid storing full opencode logs or secrets in the run record.
- Do not capture provisioning or conversational orchestrator output yet.

### Implementation Notes

Recommended implementation:

1. Add a small final-response capture helper with bounded output-tail buffering, ANSI stripping, redaction, and metadata.
2. Extend `TaskRunRecord` with `finalResponse`.
3. Capture the worker session output tail from the opencode child process.
4. Store the final-response record immediately after the normal worker session exits.
5. Include final-response metadata in launch results when useful.
6. Update `runs eval` to prefer `--final-response-file` and otherwise use `record.finalResponse.text`.

### Acceptance Criteria

Phase 5D is complete when:

- Normal worker run records can store bounded final output text with source, capture time, truncation, and log metadata.
- Stored final output is redacted before persistence.
- `runs eval <run-id>` uses stored final output without a side file.
- `--final-response-file` still overrides stored output.
- Tests cover bounded capture, redaction, stored-output eval scoring, and response-file override.

## Phase 6 Detailed Plan: Hard Policy Enforcement

Phase 6 moves role restrictions from soft prompt policy toward enforceable opencode permission policy and runtime diagnostics.

The key target is `canEdit: false`: a read-only role should not be able to mutate through opencode edit tools or through broad shell access. Native opencode read/search tools should remain available.

### Phase 6 Goals

- Make generated primary-agent permissions reflect worker capability policy more strictly.
- Keep native opencode read/search tools available for read-only roles.
- Deny broad shell access for `canEdit: false` roles.
- Allow only narrow, structured read-only or evidence commands for read-only roles.
- Keep helper subagents strictly read-only.
- Preserve builder behavior for implementation roles.
- Add tests that distinguish native read/search tools from shell commands.

### Permission Policy

Initial generated-primary policy:

- `canEdit: true`: builder-style primary agent can use normal edit/build tool surface, subject to publication gates.
- `canEdit: false`: deny opencode `edit` permission and deny broad `bash`.
- `canEdit: false`: allow `openteam verify *` and `./scripts/openteam verify *` so roles that need evidence can record it.
- `canEdit: false`: allow `openteam repo policy *` and `./scripts/openteam repo policy *` for read-only policy inspection.
- `canPublishPr: false`: deny obvious PR publication commands and `git push*`.
- `canSpawnSubagents: false`: deny `task`.

This is not a full operating-system sandbox. It is a stronger opencode-level guard that should later be combined with runtime wrappers where needed.

### Non-Goals

- Do not remove opencode native read/search tools from researchers, QA, or triagers.
- Do not make opencode native `plan` the default worker agent.
- Do not add persistent browser sessions.
- Do not change PR evidence gating.
- Do not introduce live model evals.

### Acceptance Criteria

Phase 6 is complete when:

- Generated read-only primary agents deny `edit`.
- Generated read-only primary agents deny broad `bash`.
- Generated read-only primary agents allow only narrow `openteam verify` and repo-policy inspection shell commands.
- Generated read-only primary agents deny PR publication and `git push`.
- Builder primary agents are not made read-only by accident.
- Tests cover researcher, QA, triager, and worker-profile capability overrides.

## Phase 7 Detailed Plan: Live Test Harness

Phase 7 should add repeatable live smoke tests against disposable repos and tasks.

The harness should exercise real opencode launches without publication:

- builder code task
- researcher read-only task
- QA or triage task
- generated primary-agent selection
- task manifest creation
- evidence recording
- `runs evidence`
- `runs eval`
- cleanup and stale handling

The harness should default to dry-run or local-only behavior and should not publish PRs or mutate real upstream repositories.

## Phase 8 Detailed Plan: Batch Evals And Metrics

Phase 8 should extend single-run evals into operational metrics.

Candidate command shapes:

```text
openteam runs eval --latest 20
openteam runs eval --role builder --latest 50
openteam runs eval --family <run-id>
```

Useful aggregate metrics:

- eval pass/fail rate
- evidence level distribution
- missing final-response labels
- PR eligibility mismatch count
- role handoff warnings
- terminal runs missing diagnostics
- repeated family failure categories

## Phase 9 Detailed Plan: Publication Dry-Run Hardening

Phase 9 should validate publication behavior before heavy real publication testing.

Goals:

- Exercise Nostr-git PR/comment/status/label publication in dry-run or sandbox mode.
- Prove evidence gates cannot be bypassed accidentally.
- Verify generated publication payloads include the expected repo, branch, commit, and relay policy.
- Add operator-visible diagnostics for publication blockers.
- Keep real publication behind explicit operator intent.
