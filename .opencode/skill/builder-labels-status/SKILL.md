---
name: builder-labels-status
description: Builder guidance for inspecting and publishing NIP-32 labels and NIP-34 status events.
---

Use this skill when a builder needs to update issue or PR state using labels or status events.

Use the active codebase's NIP-22, NIP-32, and NIP-34 implementation as the semantic source of truth.

## Intent

Use labels and statuses to clarify repository state, not to narrate every action.

Before publishing anything:

1. inspect the current issue or PR thread
2. inspect existing labels
3. inspect existing statuses
4. determine whether a reply is enough

If a plain comment is enough, do not publish a label or status event.

## Labels

NIP-32 label events use:

- kind `1985`
- namespace tags `L`
- label tags `l`
- issue/repo targets via `e` and `a`
- people targets via `p`

Inspect the active codebase's label helpers and publish path before inventing tag shapes.

### When to use labels

Use labels when you need durable repository classification, assignment, or workflow state that should be machine-readable.

Examples:

- assign builder role responsibility
- mark triage class or subsystem
- apply repo-specific workflow labels already used by the project

Do not invent namespaces or label schemes when the repo already has conventions.

### Role label pattern

Default role-label namespace used by the current reference implementation:

```text
org.nostr.git.role
```

Pattern:

```bash
nak event \
  --kind 1985 \
  -t 'L=org.nostr.git.role' \
  -t 'l=builder;org.nostr.git.role' \
  -e <issue-root-id> \
  -t 'a=<repo-addr>' \
  -p <assignee-pubkey> \
  --auth \
  <relay...>
```

Rules:

- target the issue root with `e`
- include repo address `a` when known
- include `p` only for real assignees/people targets
- inspect existing labels first if possible

## Status events

NIP-34 status events are used for thread state.

Kinds:

- `1630` open
- `1631` applied
- `1632` closed
- `1633` draft

Inspect the active codebase's status helpers and resolution logic before publishing state changes.

### Status precedence

The current reference implementation resolves statuses with precedence:

1. maintainer
2. root author
3. others

Then by:

1. status kind precedence
2. recency

So builder should not casually publish state changes that look authoritative unless it is actually acting in the right role/context.

### When to use statuses

Use statuses when the repository should understand a thread as:

- still open
- draft / not ready
- applied / resolved
- closed

Do not use a status event just to say “I started looking”. A reply is better for that.

### Status event pattern

Use raw `nak event` when a status event is needed:

```bash
nak event \
  --kind 1630 \
  -e <root-id> \
  -t 'a=<repo-addr>' \
  -p <recipient-pubkey> \
  -c 'status explanation' \
  --auth \
  <relay...>
```

Notes:

- root thread target is required
- repo address `a` should be included when known
- include relevant recipients in `p`
- use `1631` / `1632` / `1633` as appropriate

## Decision rule

Prefer this order:

1. reply
2. label
3. status

Use the more structured primitive only when the task actually needs structured repository state.

## Builder-specific guidance

- verify first, then publish state
- use browser evidence for UI fixes before marking a thread applied/closed
- do not use deprecated code-carrying patch flow
- if the repo culture is unclear, reply first and publish structured state only when necessary
