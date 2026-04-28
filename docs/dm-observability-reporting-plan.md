# DM Observability Reporting Plan

Goal: keep operator DMs useful for unattended runs without turning every run observation into a stream of low-signal messages.

## Problem

The current runtime reports launch/start, browser URL availability, terminal state, and warning or critical run observations. This is operationally correct but noisy when many runs enter `needs-review`, stale cleanup produces repeated transitions, or the same run keeps changing evidence metadata without a meaningful operator decision point.

The operator needs concise DMs that answer:

- what changed
- whether action is needed
- which run/check should be inspected
- whether this is new or a repeat of an already-reported condition

## Reporting Contract

DMs should be decision-oriented, not log-oriented.

Report immediately:

- one launch acceptance message with run id, role, target, and task slug
- browser URL availability for web runs, only once per run and only after health succeeds
- terminal `succeeded`, `failed`, `stale`, or `needs-review`
- a new critical failure category that has not already been reported for that run
- explicit operator-requested status replies

Do not DM immediately:

- every evidence count change
- every repeated dev-health failure while the same run is already reported unhealthy
- raw active phase transitions unless the operator asked to watch a run
- repeated `needs-review` transitions for continuations in the same run family
- stale observations already represented in `openteam status`

## Message Shape

Use a compact stable template:

```text
[builder-01] needs-review verification-evidence-missing
run: builder-01-20260427-...
family: 20260427-fix-checkout-flow
target: nostr://npub.../repo
mode: web
task: fix checkout flow
evidence: weak, PR no
why: missing browser evidence
next: openteam runs evidence <run-id>
```

For failures:

```text
[researcher-01] failed verification-failed
run: researcher-01-20260427-...
family: 20260427-review-pr-event
target: 30617:<owner>:nostr-git-ui
mode: code
task: review PR event nevent1...
evidence: strong, PR no
why: verification-failed: repo-native exited 1
artifact: .openteam/artifacts/verification/repo-native-...
next: openteam runs show <run-id>
```

For digest mode:

```text
openteam run digest
failed: 2
needs-review: 4
stale: 1
top: builder-01-... verification-failed; researcher-01-... missing evidence
next: openteam status
```

## Minimum Metadata

Every non-acknowledgement DM should include enough metadata to identify the run without opening JSON:

- `run`: exact run id
- `family`: stable grouping key for original run plus continuations
- `role`: implied by the message prefix, or explicit in digest rows
- `state`: final or effective state
- `failure`: failure category when present
- `target`: compact repo target, preserving enough owner/repo identity to distinguish repos
- `mode`: `web` or `code`
- `task`: one-line task slug or summary
- `evidence`: evidence level plus PR eligibility
- `context`: context id only when debugging leases, stale state, or same-repo continuations
- `next`: one concrete command or decision

Optional metadata may be included only when it changes the operator decision:

- `url`: live browser URL for healthy web runs
- `log`: primary log path for failed runs
- `checkout`: only for failed, stale, or needs-review runs where local inspection is likely
- `duration`: terminal reports and digests
- `attempt`: continuation or retry number within the run family

Digest rows should use a single compact line per run:

```text
- failed builder-01 run=... family=fix-checkout-flow target=repo mode=web why=dev-server-unhealthy next="openteam runs show ..."
- needs-review researcher-01 run=... family=review-pr target=nostr-git-ui evidence=none next="openteam runs evidence ..."
```

## Runtime Design

Add a small DM reporting state file:

```text
runtime/orchestrator/dm-report-state.json
```

Store per run:

- last reported state
- last reported failure category
- last reported evidence level
- last reported recommended action
- last reported at
- report count
- run family key, derived from continuation ancestry when present

Report suppression rules:

- suppress same `(runId, state, failureCategory, evidenceLevel)` repeats
- suppress repeated run-family `needs-review` messages unless failure category changes
- throttle warning-level observation reports to one per run per 30 minutes
- always allow critical terminal failures through once
- digest suppressed warnings every configured interval if any remain actionable

## CLI And Config

Add config:

```json
{
  "reporting": {
    "dmObservationMode": "terminal",
    "dmDigestIntervalMs": 1800000,
    "dmWarningThrottleMs": 1800000
  }
}
```

Modes:

- `terminal`: only launch, URL, terminal, explicit failures
- `digest`: terminal plus periodic digest of warnings/needs-review
- `verbose`: current behavior for debugging

Add commands:

```bash
openteam reports state
openteam reports digest --now
openteam reports reset <run-id>
```

## Implementation Order

1. Introduce `src/reporting-policy.ts` with pure functions that decide `send`, `suppress`, or `digest`.
2. Add tests for repeated observation suppression, new failure-category reporting, and digest grouping.
3. Wire `serveAgent` observation reporting through the policy before `sendRuntimeReport`.
4. Shorten terminal task reports to the stable templates above.
5. Add config defaults and document operator tuning in `docs/operations.md`.

## Non-Goals

- Do not replace run records or `runtime/orchestrator/observations.json`.
- Do not let observation mutate run state or launch continuations.
- Do not send raw logs over DM.
- Do not infer success from a launch message.
