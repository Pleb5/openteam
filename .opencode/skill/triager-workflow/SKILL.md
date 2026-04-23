---
name: triager-workflow
description: Front-line triage workflow for Nostr git issues and reports using read-first inspection, reproduction, and clear routing.
---

Use this skill when a triager agent is handling incoming issue-shaped work, bug reports, vague complaints, or requests that need classification before builder time is spent.

## Intent

The triager reduces ambiguity.

Default sequence:

1. inspect the current issue or report carefully
2. determine whether enough information exists to reproduce or classify it
3. reproduce when feasible
4. classify severity, scope, subsystem, and next action
5. only then publish labels, status, or a reply if they improve shared understanding

The triager should make builder work easier, not noisier.

## Primary tools

- use OpenCode tools for code inspection, git inspection, and browser reproduction
- use `nak` for issue, comment, and relay inspection when repository state is on Nostr
- prefer shared skills first:
  - `nostr-git-map`
  - `nak-git-read`

## Do First

Before classifying or labeling anything, inspect current state:

```bash
nak git sync
nak git status
nak git issue
nak git issue <issue-id-prefix>
```

If the report is UI-shaped, reproduce it in the browser before assigning strong confidence.

## Reproduction rules

Reproduce when:

- the report describes visible behavior
- the issue claims a bug or regression
- the report is vague and could be many things

Do not waste time on full reproduction when:

- the issue is obviously a request for enhancement
- the problem is impossible to reproduce with available credentials or context
- the repository state already makes the root cause obvious and reproducible enough by inspection

When reproduction fails:

- say exactly what was attempted
- say what was missing
- do not pretend the issue is invalid just because reproduction failed once

## Classification outputs

Every triage pass should try to leave behind these conclusions:

1. severity
2. scope
3. likely subsystem
4. reproducibility level
5. recommended next owner or next action

Suggested severity vocabulary:

- critical
- high
- medium
- low
- enhancement

Suggested reproducibility vocabulary:

- confirmed
- likely
- unclear
- blocked

Suggested next action vocabulary:

- builder-next
- qa-next
- needs-info
- wont-fix
- duplicate

## Reply vs label vs status

Prefer this order:

1. reply
2. label
3. status

Use a reply when:

- you need to ask for more information
- you want to record reproduction steps or blockers
- classification is still provisional

Use labels when:

- the repository benefits from machine-readable triage state
- the issue should be routed or categorized
- assignment or ownership should be visible

Use status when:

- the repository workflow expects thread state changes
- the triage outcome should explicitly change the lifecycle of the issue

Do not publish structured state just because it is available.

## Triage outcomes

### Good triage comment

A good triage reply should be short and concrete:

- what was reproduced
- what was not reproduced
- likely subsystem
- what should happen next

Example shape:

```text
Reproduced on current main branch in browser.
Likely subsystem: auth / relay routing.
Severity: medium.
Next action: builder should inspect relay-list handling and profile sync visibility.
```

### Good escalation

Escalate to builder when:

- reproduction is confirmed or very likely
- the issue is concrete enough to implement against
- the next best step is code change rather than more questioning

Escalate to QA when:

- the issue needs broader scenario exploration
- multiple real-data/browser flows need validation
- the correctness question is mainly behavioral, not implementation-shaped yet

## Anti-patterns

Do not:

- label everything immediately without reading the thread
- close issues just because they are hard to reproduce
- escalate to builder when the issue still needs basic clarification
- write long speculative essays instead of leaving a crisp triage result

## Communication boundary

Operator status DMs are runtime-owned.

- do not manually send operator DMs as part of normal triage
- only use Nostr messaging tools when the task itself is about messaging behavior

## Summary

- inspect first
- reproduce when it matters
- classify clearly
- route with minimal noise
- use replies, labels, and statuses only when they improve shared repository understanding
