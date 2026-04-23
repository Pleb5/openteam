---
name: builder-workflow
description: Builder workflow for Nostr git work using nak, browser verification, labels, statuses, and PR events.
---

Use this skill when a builder agent is implementing or fixing work for a Nostr git repository and may need to inspect or publish repository issues, labels, statuses, or PR events.

## Intent

The builder turns approved work into a verified implementation.

Default sequence:

1. Inspect current repo and discussion state first.
2. Reproduce the problem when the task is bug-shaped.
3. Make the smallest correct code change.
4. Verify with repo-native checks.
5. Verify in the browser when UI behavior matters.
6. Only then publish repo-side Nostr updates if the task actually requires them.

## Primary tools

- Use OpenCode tools for code edits, git commands, and browser work.
- Use `nak` when you need direct Nostr git operations.
- Prefer the highest-level `nak git ...` command available before falling back to raw `nak event`.

## Do First

Before publishing anything, inspect the current state:

```bash
nak git sync
nak git status
nak git issue
nak git issue <issue-id-prefix>
```

If you need to inspect relays or specific events directly, prefer read-only commands first:

```bash
nak req ...
nak fetch ...
nak decode ...
```

## Issues

Use built-in `nak git issue` commands for issue workflows:

```bash
nak git issue
nak git issue <issue-id-prefix>
nak git issue create
nak git issue reply <issue-id-prefix>
nak git issue close <issue-id-prefix>
```

Builder guidance:

- inspect the issue thread before replying or closing
- do not close an issue just because local code changed; close it only when the fix is actually verified
- if the issue is unclear, reply with concrete reproduction or blocker notes instead of guessing

## Labels

There is no first-class `nak git label` command. For labels, use a raw NIP-32 label event (`kind: 1985`) with `nak event`.

Important details from the current Nostr git reference implementation:

- label event kind: `1985`
- namespace marker tag: `L`
- label tag: `l`
- issue/repo targets use `e` and `a`
- people targets use `p`

For role-style assignment labels, default namespace is:

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

- inspect existing labels first if possible
- target the issue root with `e`
- include the repo address with `a` when known
- do not invent label namespaces unless the repo already uses them

## Status events

Status events are first-class NIP-34 events, not comments.

Kinds:

- `1630` open
- `1631` applied
- `1632` closed
- `1633` draft

Use raw `nak event` for status publishing when the repo workflow needs it.

Required pattern:

- root issue/patch/PR in `e` with root marker semantics
- optional repo address in `a`
- optional recipients in `p`

Rules:

- inspect current statuses before publishing a new one
- do not casually override thread state
- use status only when it helps the repository workflow, not as redundant narration

## Pull requests

Do not use deprecated code-carrying patch events for the builder workflow.

Builder policy:

- normal git branches and commits are the default
- browser verification and code verification come before Nostr PR publication
- only publish PR events when the task or repo workflow actually requires NIP-34 PR wrappers

Important: code-carrying patches are deprecated for this workflow.

- Do **not** use `nak git patch send` unless a user explicitly asks for legacy patch flow.

For true PR publication, use raw NIP-34 PR events:

- PR event kind: `1618`
- PR update kind: `1619`

Important tags for PR `1618`:

- `a` repo address
- `subject`
- `t` labels
- `c` tip commit OID
- optional `clone`
- optional `branch-name`
- optional `merge-base`
- optional `p` recipients

Important tags for PR update `1619`:

- `a` repo address
- `E` PR event id
- `P` PR author pubkey
- `c` tip commit OID
- optional `merge-base`
- optional `clone`
- optional `p` recipients

When publishing raw PR events:

- derive tag shape from the repo and current state, not memory alone
- prefer repo announcement relays and current repo workflow relays
- include `--auth` when publishing to relays that require NIP-42 auth

## Browser verification

When the task touches UI, the browser is the source of truth.

- trust the browser over assumptions in code
- check visible behavior, console, and network when relevant
- do not claim success until the UI behavior is observed

## Communication boundary

Operator status DMs are runtime-owned.

- do not send operator DMs manually as part of the builder workflow
- only use Nostr messaging tools when the task itself is about messaging or repo-side communication

## Repo guidance

When you need exact event semantics, inspect the active codebase's NIP-22, NIP-32, and NIP-34 implementation before guessing.

## Summary

- inspect first
- build second
- verify third
- publish repo-side Nostr state only when needed
- no code-carrying patches in normal builder flow
