# Orchestrator Stability Plan

Goal: keep the orchestrator useful as the operator-facing control plane without letting it amplify failed, stale, or incomplete runs into repeated continuations.

## Problem

Recent run history showed chains of failed, stale, interrupted, and `needs-review` runs. The runtime already has useful diagnostics and evidence gates, but the orchestrator behavior still makes it too easy to treat every incomplete run as an invitation to continue.

The desired behavior is:

- one operator request maps to a bounded run family
- every continuation has an explicit reason
- evidence gaps become review decisions, not automatic reruns
- repeated infrastructure failures stop quickly with a clear blocker
- the orchestrator reports operational truth from run records, not optimism from launch acceptance

## Control Rules

These rules should be enforced by code and reinforced in orchestrator role instructions.

1. `needs-review` is terminal by default.
   It means the worker completed a task phase but did not satisfy the evidence gate. The orchestrator may recommend `runs evidence`, but it must not launch `repair-evidence` unless the operator asks or a runtime policy explicitly allows it.

2. Failed verification is not a retry signal.
   Worker-recorded failed or blocked verification should stop the run family unless the next task is explicitly scoped to fixing that failure.

3. Stale means reconcile first.
   A stale run should go through `runs diagnose` and `runs cleanup-stale --dry-run` before any continuation. Continuation should only happen after the context is idle and the failure mode is understood.

4. Repeated failure categories freeze the family.
   If two attempts in a family end with the same `failureCategory`, stop and report a blocker instead of launching another worker.

5. Continuations must name a delta.
   The continuation task must state what is different from the prior attempt: missing evidence to collect, blocker to repair, or narrowed scope. Generic “continue” is not enough.

## Runtime Model

Add a run-family controller:

```text
runtime/orchestrator/run-families.json
```

Per family, store:

- root run id
- target, mode, task summary
- attempt count
- continuation count
- last terminal state
- last failure category
- repeated failure count
- evidence level
- PR eligibility
- blocked reason when frozen
- operator approvals for continuation or parallelization

The controller should produce one of:

- `allow-launch`
- `allow-continuation`
- `needs-operator-review`
- `frozen-repeated-failure`
- `blocked-context-busy`
- `blocked-stale-unreconciled`

## Default Budgets

Start conservative:

- automatic continuations: `0`
- evidence repair without operator approval: `0`
- transient infrastructure retry: `1`, only for classified transient categories
- same failure category per family: max `1` repeat before freeze
- same-repo parallelization: operator explicit only

Transient categories may include model provider `server_error`, relay timeout during non-mutating fetch, or dev-server startup race that recovered on retry. They should not include failed tests, missing evidence, blocked verification, publication blocked, or permission rejection.

## Instruction Tightening

Update `roles/orchestrator.md`:

- Treat `needs-review` as terminal unless the operator explicitly asks for repair.
- Before `runs continue` or `runs repair-evidence`, inspect `runs evidence` and `runs diagnose`.
- Do not launch a continuation if the prior run failed for the same category as the previous attempt in the family.
- Ask for operator approval before retrying after permission rejection, publication blocked, failed verification, or context-busy.
- Use one concise status DM with the exact run id, family key, failure category, and next command.

Update worker prompts only where needed:

- Workers should record manual evidence for research/triage/QA verdicts.
- Workers should report concrete blockers instead of returning success without evidence.
- Workers should not ask or imply that the orchestrator should simply rerun them.

## Implementation Order

1. Add `src/run-family-policy.ts` with pure decision functions and tests.
2. Derive a stable family key from continuation ancestry and store it in observation/reporting state.
3. Add `openteam runs family <run-id>` to show attempts, outcomes, evidence, and freeze reasons.
4. Gate `runs continue` and `runs repair-evidence` through the family policy unless `--force` or an explicit operator approval flag is provided.
5. Update `roles/orchestrator.md` with the tightened continuation rules.
6. Add status/DM summaries that show `family`, `attempt`, `failureCategory`, and `next`.

## Acceptance Checks

- A `needs-review` run does not automatically create another run.
- A second same-category failure in a family blocks further continuation by default.
- Stale runs must be reconciled before continuation.
- `runs continue --dry-run` prints the policy decision and required approval when blocked.
- Orchestrator DM/status responses never claim launch acceptance as proof of progress.
- The operator can still override the policy explicitly when they want another attempt.

## Non-Goals

- Do not add a scheduler.
- Do not make the orchestrator do repository work directly.
- Do not delete checkouts during reconciliation.
- Do not hide failed evidence to make a run look successful.
