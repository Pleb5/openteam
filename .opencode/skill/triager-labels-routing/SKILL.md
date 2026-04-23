---
name: triager-labels-routing
description: Triager guidance for labeling, routing, and issue-state updates using NIP-32 labels, NIP-34 statuses, and issue replies.
---

Use this skill when a triager needs to turn a diagnosis into repository-visible routing or triage metadata.

This skill is narrower than `triager-workflow`.

## Intent

The triager uses the lightest structured signal that makes the issue clearer for the next person.

Use:

- reply for narrative clarification
- label for durable classification/routing
- status for lifecycle state

## Labels

Use NIP-32 label events (`kind 1985`) when the issue should carry machine-readable triage metadata.

Typical triage label families:

- severity
- subsystem
- routing / next owner
- reproduction state

Do not invent namespaces if the repository already has them.

If no existing namespace is known, keep the namespace stable and explicit.

Example namespaces:

- `org.nostr.git.severity`
- `org.nostr.git.subsystem`
- `org.nostr.git.route`
- `org.nostr.git.repro`

### Example severity label

```bash
nak event \
  --kind 1985 \
  -t 'L=org.nostr.git.severity' \
  -t 'l=high;org.nostr.git.severity' \
  -e <issue-root-id> \
  -t 'a=<repo-addr>' \
  --auth \
  <relay...>
```

### Example routing label

```bash
nak event \
  --kind 1985 \
  -t 'L=org.nostr.git.route' \
  -t 'l=builder-next;org.nostr.git.route' \
  -e <issue-root-id> \
  -t 'a=<repo-addr>' \
  --auth \
  <relay...>
```

### Example repro label

```bash
nak event \
  --kind 1985 \
  -t 'L=org.nostr.git.repro' \
  -t 'l=confirmed;org.nostr.git.repro' \
  -e <issue-root-id> \
  -t 'a=<repo-addr>' \
  --auth \
  <relay...>
```

Rules:

- inspect existing labels first
- target the issue root with `e`
- include repo address `a` when known
- do not pile on redundant labels if one clear label is enough

## Statuses

Use NIP-34 statuses when triage should change lifecycle state.

Relevant kinds:

- `1630` open
- `1632` closed
- `1633` draft

Triage status guidance:

- use `1630` if a thread should explicitly remain open after clarification
- use `1633` when the issue is acknowledged but not yet actionable
- use `1632` only when closure is truly justified by triage outcome

Do not close issues casually.

Example:

```bash
nak event \
  --kind 1633 \
  -e <root-id> \
  -t 'a=<repo-addr>' \
  -p <issue-author-pubkey> \
  -c 'Draft triage: needs reproduction details before builder handoff.' \
  --auth \
  <relay...>
```

## Preferred routing decisions

Use these routing outcomes consistently:

- `builder-next`
- `qa-next`
- `needs-info`
- `duplicate`
- `wont-fix`

And these reproduction outcomes consistently:

- `confirmed`
- `likely`
- `unclear`
- `blocked`

Consistency matters more than clever taxonomy.

## Decision rule

If the thread still needs explanation, reply first.

If the classification needs to be machine-readable, label it.

If the lifecycle state itself should change, publish a status event.

## Summary

- classify cleanly
- route explicitly
- label sparingly but consistently
- close only with strong justification
