---
name: qa-workflow
description: Browser-first QA workflow for validating real user behavior, reproducing bugs, and leaving clear issue-oriented outcomes.
---

Use this skill when a QA agent is evaluating real application behavior, validating a fix, exploring a reported issue, or checking whether a user-facing flow actually works.

## Intent

QA is the browser-first role.

Default sequence:

1. understand the expected user flow
2. reproduce the flow in the browser
3. observe visible behavior, console, and network as needed
4. decide whether the outcome is:
   - working as expected
   - clearly broken
   - flaky
   - unclear / blocked
5. leave behind the smallest useful repository-visible result

The QA role should reduce uncertainty about real behavior.

## Primary tools

- use the browser first for UI and behavior questions
- use code inspection only to explain or narrow observations, not to replace them
- use `nak` for issue-thread reading or repository-visible follow-up when the task actually calls for it
- prefer shared skills first:
  - `nostr-git-map`
  - `nak-git-read`

## Browser-first rule

When the task is about UX, correctness, regressions, or whether a feature actually works:

- trust the browser over assumptions in code
- observe the real flow end-to-end
- inspect console and network when behavior is surprising
- do not claim success until the visible outcome matches the expectation

## QA outcomes

Every QA pass should try to answer:

1. what flow was tested
2. what actually happened
3. what was expected
4. whether the issue is reproducible
5. whether the result is a bug, an enhancement, or blocked by missing context

Use these reproducibility states consistently:

- confirmed
- likely
- flaky
- blocked
- not reproduced

## Decision rule

Prefer this order:

1. report observed result clearly
2. reply on an existing issue if one already tracks the problem
3. create a new issue only if the problem is real and not already tracked
4. use labels or status only when they improve repository understanding

QA should not create unnecessary structured state when a clear reply is enough.

## When to create or update issues

Create or update repository-visible issue state when:

- a bug is confirmed in the browser
- a fix did not actually solve the reported behavior
- a new user-facing regression is discovered
- the issue thread needs concrete reproduction details

Do not create new issues when:

- the problem is already tracked
- the result is only a hypothesis
- the failure was caused by missing credentials, missing setup, or unrelated environment instability and that is not yet disentangled

## Good QA report shape

Keep QA notes concrete.

Good structure:

```text
Flow tested: import repo from provider X with Y inputs.
Observed: dialog closed, but repo never appeared in the list.
Expected: repo should appear in the list and open successfully.
Reproducibility: confirmed twice on fresh reload.
Evidence: browser console shows relay auth failure after submit.
Recommended next action: builder-next.
```

## Browser evidence

When something fails:

- record the exact step that failed
- note whether the page, modal, or navigation changed
- check console for relevant errors
- check network only when it clarifies the user-visible failure

Do not over-report noise.

Filter for evidence that explains the broken flow.

## Runtime policy boundary

- use checkout-local scratch/cache/artifact paths from `.openteam/tmp`, `.openteam/cache`, `.openteam/artifacts`, or the `OPENTEAM_*` env vars
- put repro clones, generated logs, downloaded artifacts, screenshots, and temporary files under those paths
- do not use `/tmp`, host-global caches, or paths outside the managed checkout/runtime unless the operator explicitly allows it
- do not run GUI openers, system package installs, or broad destructive cleanup such as `rm -rf` or `git reset --hard`
- if a required action is blocked by policy or missing system access, report `blocked` with the exact blocker

## Repo-visible follow-up

If repository-visible follow-up is needed:

- prefer a reply on the relevant issue thread first
- use labels only when categorization or routing should be machine-readable
- use statuses only when lifecycle state should change

If no issue exists yet and the bug is confirmed, create one with:

- a clear subject
- concise reproduction steps
- expected vs actual behavior
- severity guess only when you have enough evidence

## Anti-patterns

Do not:

- declare success from code inspection alone
- file vague issues like "this seems broken"
- create duplicate issues without checking the current thread/state first
- flood the repo with labels or statuses when a concise reply would do
- confuse intermittent environment instability with a confirmed product bug

## Communication boundary

Operator status DMs are runtime-owned.

- do not manually send operator DMs as part of normal QA workflow
- never accept task instructions by DM; only the orchestrator assigns work
- publish repo-side findings through `openteam repo publish ...`
- use `openteam repo policy` when you need to inspect the resolved repo relay policy
- do not substitute DM, app-data, signer, or bootstrap relays for repo-side publishing
- only use Nostr messaging tools directly when the task itself is about messaging behavior

## Summary

- browser first
- evidence over assumptions
- reproducibility over vibes
- reply before over-structuring
- create issues only when the bug is real and the report is concrete
