---
name: nak-git-read
description: Shared read-only guidance for inspecting Nostr git repositories, issues, statuses, comments, and relay state with nak.
---

Use this skill when you need to inspect repository state before acting.

Primary rule:

- inspect first
- publish second

## Preferred commands

Repository state:

```bash
nak git sync
nak git status
```

Issues:

```bash
nak git issue
nak git issue <issue-id-prefix>
nak git issue --all
nak git issue --closed
```

Patches still appear in some repos and relay histories, but they are not the default workflow here.
Only inspect them when the task explicitly mentions them:

```bash
nak git patch
nak git patch <patch-id-prefix>
```

Low-level relay inspection:

```bash
nak req ...
nak fetch ...
nak decode ...
```

## Reading rules

- prefer `nak git ...` before raw relay reads
- inspect the thread before replying, labeling, or publishing status
- if you use raw relay reads, summarize:
  - ids
  - kinds
  - authors
  - timestamps
  - root/target relationships
- do not dump large raw JSON unless the task explicitly needs it

## Issue-thread reading guidance

For issues, determine:

1. root issue id
2. root author
3. repo address
4. current comments
5. current statuses
6. whether maintainers are visible from repo announcement context

Issue resolution in the current reference implementation depends on status precedence and thread assembly, so reading the whole thread matters.

## Relay guidance

- use repo relays for repo-scoped objects
- use relay discovery only when repo relays are missing or insufficient
- if a relay rejects writes, that does not necessarily invalidate read inspection

## Source references

- `nak/README.md`
- `nak git --help`
- `nak git issue --help`
- `nak git status --help`
- `packages/nostr-git-core/src/events/nip34/issues.ts`
- `packages/nostr-git-core/src/events/nip22/nip22.ts`

When in doubt, inspect first and keep conclusions concrete.
