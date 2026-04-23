---
name: nostr-git-map
description: Shared reference map for Nostr git event kinds, tag intent, and repository concepts.
---

Use this skill when working with any Nostr git workflow and you need the canonical event map before reading or publishing events.

## Core kinds

Repository:

- `30617` repository announcement
- `30618` repository state

Issues and comments:

- `1621` issue
- `1111` NIP-22 comment

Pull requests:

- `1618` pull request
- `1619` pull request update

Statuses:

- `1630` open
- `1631` applied
- `1632` closed
- `1633` draft

Labels:

- `1985` NIP-32 label event

User git state:

- `10317` user GRASP list

## Important concepts

### Repository announcement

Repository announcements are the root identity object for a repo.

Important tags:

- `d` repo identifier
- `name`
- `description`
- `web`
- `clone`
- `relays`
- `r ... euc`
- `maintainers`

### Issue

Issue root is kind `1621`.

Important tags:

- `a` repo address
- `p` recipients or owner/maintainer context
- `subject`
- optional `t`

### NIP-22 comment

Comments and replies use kind `1111`.

Root scope uses uppercase tags:

- `E`
- `A`
- `P`
- `K`
- `R`

Parent scope uses lowercase tags:

- `e`
- `a`
- `p`
- `k`
- `r`

Issue replies should be modeled as NIP-22 comments, not deprecated NIP-34 reply kinds.

### Pull request

PR root is kind `1618`.

Important tags:

- `a` repo address
- `subject`
- `t` labels
- `c` tip commit oid
- optional `clone`
- optional `branch-name`
- optional `merge-base`
- optional `p` recipients

PR update is kind `1619`.

Important tags:

- `a` repo address
- `E` PR event id
- `P` PR author pubkey
- `c` updated tip commit oid
- optional `merge-base`
- optional `clone`
- optional `p` recipients

### Status event

Status events use:

- root `e`
- optional repo `a`
- optional recipients `p`
- optional `merge-commit`
- optional `applied-as-commits`

The current reference implementation resolves final status by:

1. maintainer over root author over others
2. kind precedence
3. recency

### Label event

Labels use kind `1985`.

Important tags:

- `L` namespace
- `l` label value, optional namespace, optional `del`
- targets through `e`, `a`, `p`, `r`, `t`

## Relay model

Keep the relay buckets conceptually separate:

- outbox relays: the agent's canonical relay identity
- DM relays: DM inbox/outbox control plane
- signer relays: bunker only
- git-data relays: current app-specific git/profile fallback set

Do not collapse these into one relay bucket mentally.

## Source guidance

When in doubt, inspect the active codebase's NIP-22, NIP-32, and NIP-34 implementation before guessing event shapes.
