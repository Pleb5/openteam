# OpenCode Runtime Behavior Plan

Goal: make unattended openteam workers reliable even when OpenCode is alive but waiting, blocked, or silent.

## Behavioral States

An OpenCode worker run should be observed as one of these operational states:

- `progressing`: OpenCode stdout/stderr or worker evidence is moving.
- `idle-thinking`: OpenCode is silent briefly but below warning thresholds.
- `opencode-idle-warning`: OpenCode has produced no output for the warning threshold while the phase is still active.
- `opencode-idle-critical`: OpenCode has produced no output for the critical threshold while the phase is still active.
- `permission-blocked`: OpenCode requested a permission decision or hit a rejected permission.
- `question-blocked`: OpenCode requested interactive input.
- `policy-blocked`: OpenCode/runtime policy blocked an operation.
- `terminal`: the run finished, failed, went stale, was interrupted, or needs review.

Dev-server health is not worker progress. A healthy dev URL only proves the web runtime is reachable.

## Worker Authority

openteam workers intentionally have more authority than a normal user-interactive OpenCode session. They receive managed Git credentials, Nostr signing identities, isolated browser profiles, checkout-local scratch/cache paths, and publication helpers so they can complete more work unattended.

That authority is bounded by ownership:

- workers own repository work, verification, branch preparation, and policy-allowed publication;
- the orchestrator owns worker lifecycle, stale-run diagnosis, cleanup, continuation gates, and repo-context lease release;
- the operator owns product scope ambiguity, secrets, system changes, and high-risk publication/destructive decisions.

## Interactive Questions

Non-orchestrator workers must not ask interactive questions during unattended execution. If they require a human decision, they should stop with a concrete blocker and the exact decision needed.

The orchestrator and local operator console may ask questions because their role is to clarify operator intent and lifecycle policy.

## Permission Requests

When a worker wants permission it should be classified by who can safely decide.

The orchestrator may decide without operator escalation when the request is for:

- same-run or same-family runtime diagnosis;
- stale cleanup dry-run or matching-lease cleanup;
- continuation or evidence-repair eligibility;
- sanitized prior-run summaries, log tails, failure categories, missing evidence, or PR blockers;
- bounded status and policy checks already exposed through openteam CLI commands.

The runtime should avoid giving workers direct access to orchestrator runtime files. Instead, the orchestrator should copy sanitized context into checkout-local `.openteam/context/` or `.openteam/task.json`.

Escalate to the operator for:

- external directory read/write outside managed checkout/runtime;
- secrets, private keys, tokens, or personal browser/profile access;
- system package installs or desktop/system configuration;
- destructive filesystem or Git operations;
- force push, branch deletion, or publication despite weak evidence;
- login or remote signer actions requiring human interaction;
- product/scope/design ambiguity;
- repeated same-category failures after family policy budget is exhausted.

## No Worker Wall Clock Timeout

Worker phases are not capped by a fixed wall-clock timeout. Long tasks are allowed.

openteam should instead apply lower-level limits:

- command verification runners have explicit timeouts;
- OpenCode idle warnings/critical alerts are based on lack of output, not total duration;
- permission/question blockers are detected from logs and reported immediately;
- auto-stop remains a separate explicit policy choice, not the default consequence of a long run.

## Reporting Contract

The orchestrator should learn promptly when:

- OpenCode has no output past the warning or critical threshold;
- OpenCode requests or rejects a permission;
- OpenCode appears to ask an interactive question;
- a worker tries to inspect orchestration runtime internals;
- a run has no verification evidence but remains active long enough to be suspicious.

DM reports should include:

- exact run id;
- active phase and phase duration;
- OpenCode idle age and last meaningful log line;
- blocked kind and evidence when available;
- dev URL health, explicitly labeled as runtime health;
- one next command or decision owner.
