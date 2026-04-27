# Event Model

This document records the current Nostr event model used by `openteam` runtime behavior.

It focuses on runtime-owned events and the event families agents are expected to understand.

Canonical event kind and tag constants live in `src/events.ts`. Runtime code should import those names rather than reintroducing numeric kind literals.

## Runtime-owned events

These events are handled by `openteam` itself, not by ad hoc agent improvisation.

## Runtime Publish Matrix

This table is the compact reference for current runtime-owned event publishing behavior.

| Kind / mechanism | Meaning | Published or transported via |
| --- | --- | --- |
| `10002` | Outbox relay list | `outboxRelays + relayListBootstrapRelays` |
| `10050` | Orchestrator DM relay list | `outboxRelays + relayListBootstrapRelays` |
| `4444` | Operator/control-plane DM to orchestrator | `dmRelays + recipient discovered 10050 inbox relays` |
| `30078` with `d=app/nostr-git/tokens` | Provider token profile/config | `appDataRelays + nostr_git.gitDataRelays` |
| `30002` with `d=grasp-servers` | GRASP server preference profile/config | `appDataRelays + nostr_git.gitDataRelays` |
| NIP-46 signer transport | Remote signer traffic | `signerRelays` only |

Important interpretation:

- `graspServers` is the value stored inside the `30002` profile event, not a separate publish relay bucket
- `nostr_git.gitDataRelays` is a compatibility relay set for Nostr-git profile/config visibility, not a general DM or signer relay set
- relay-list events are intentionally published to outbox + bootstrap relays, not to DM relays directly

## Repository Event Reminder

Every repository work target must resolve to a kind `30617` repository announcement before openteam creates or reuses a local repo context.
Local paths, URLs, aliases, and folder names are only hints for finding this announcement.
Direct `nostr://<owner-npub>/<repo-d-tag>` targets resolve through URI relay hints, the owner's kind `10002` outbox relays, and configured fallback announcement relays.
When the upstream announcement owner is not `orchestrator-01`, openteam creates or reuses an orchestrator-owned kind `30617` fork announcement and performs worker handoff from that fork.

Git collaboration vocabulary is NIP-34/Nostr-git-first throughout openteam.
When an operator or task says issue, PR/pull request, comment/reply, label, status, repo, or repository thread, agents should interpret that as repo-scoped Nostr-git workflow data unless the task explicitly names GitHub, GitLab, another forge, or a plain Git transport/history operation.
Plain `git` commands still refer to local Git SCM operations such as inspecting history, branching, committing, and pushing.

Repository relay selection follows the same policy as the reference client:

- if a repo announcement has GRASP smart-HTTP clone URLs, the announcement must include the corresponding GRASP relay URLs in its `relays` tag
- GRASP-backed repo announcements are published to those tagged repo relays
- non-GRASP repo announcements are published to tagged repo relays plus direct target relay hints, `nostr_git.repoAnnouncementRelays`, orchestrator `outboxRelays`, and `nostr_git.gitDataRelays`
- non-GRASP repo announcement publishing does not silently add `appDataRelays`, `relayListBootstrapRelays`, or untagged GRASP relays

These event families are task- and repo-dependent:

| Kind | Meaning | Published to |
| --- | --- | --- |
| `30617` | Repository announcement | repo-scoped / explicit repository relays |
| `1621` | Issue | repo-scoped relays |
| `1111` | Comment / reply | repo-scoped relays |
| `1985` | Label | repo-scoped relays |
| `1630-1633` | Status events | repo-scoped relays |
| `1618` | Pull request | repo-scoped relays |
| `1619` | Pull request update | repo-scoped relays |

When a worker handles repository events, it should use the active repository's own relay conventions, not the runtime control-plane relay buckets above.
Managed repo contexts include `.openteam/repo-context.json`; workers should use `openteam repo policy` and `openteam repo publish ...` so runtime policy selects the correct repo-side publish relays.
The context can default publishing to `repo` or `upstream`; workers can override with `--scope repo` or `--scope upstream` when the task explicitly targets the other side.

Long-running triager workers may read kind `1621` issue events from the active repository relays and enqueue local triage jobs.
These events are repository inputs, not authority to change worker target, permissions, model, or role.

Fork announcements published by openteam include the orchestrator-owned clone URL plus tags linking back to the upstream repo address.

## Relay identity events

### Outbox relay list

- kind: `10002`
- advertised contents: `outboxRelays`
- publish targets: `outboxRelays + relayListBootstrapRelays`

Purpose:

- advertise the agent's canonical relay identity

### DM relay list

- kind: `10050`
- advertised contents: `dmRelays`
- relay URL tags: writes both `relay` and `r` forms for client compatibility; reads both forms
- publish targets: `outboxRelays + relayListBootstrapRelays`

Purpose:

- advertise where the orchestrator expects DM/control-plane traffic
- worker agents do not publish operator control DM inboxes

## DM control-plane events

### Operator task DMs

- kind: `4444`

Use:

- inbound task intake
- immediate acknowledgement
- fast deterministic operator commands such as `help`, `status`, `start`, `stop`, `watch`, `research`, `plan`, and `work on ... and do ...`
- freeform operator requests that fall back to the conversational orchestrator path when no fast grammar matches
- sparse job reporting: launched/started, browser URL, failed, needs-review/succeeded, and warning/critical observations

Scope:

- orchestrator only
- workers must not accept instructions by DM
- worker Nostr usage is limited to assigned repository workflows, identity/profile sync, and signer/browser needs
- `allowFrom` controls who may instruct the orchestrator
- `reportTo` controls default notification recipients for TUI/CLI-originated work
- DM-originated work reports to the sender plus configured report recipients

Read path:

- subscription-first on `dmRelays`
- polling fallback on `dmRelays`

Write path:

- own `dmRelays`
- recipient-discovered `10050` inbox relays

Reporting policy:

- runtime-owned, not worker-authored
- no routine phase spam or raw log dumps
- detached worker jobs receive task source/recipient context so final reports can be routed back to the DM sender

Encryption:

- NIP-44

Signing:

- orchestrator identity secret / managed bunker-backed identity model

## Profile sync events

### Provider token profile data

- kind: `30078`
- `d` tag: `app/nostr-git/tokens`

Purpose:

- publish provider token profile state for the current identity

Publish targets:

- `appDataRelays + nostr_git.gitDataRelays`

Content:

- encrypted profile token payload

### GRASP server preference

- kind: `30002`
- `d` tag: `grasp-servers`

Purpose:

- publish remembered GRASP target relay set for the current identity

Publish targets:

- `appDataRelays + nostr_git.gitDataRelays`

Content:

- JSON object with `urls`

## Signer transport

The signer transport is not a Nostr event family in the same way as the relay/profile sync events above. It is the managed NIP-46 flow used through `nak bunker`.

Important runtime rule:

- signer transport uses only `signerRelays`

## Nostr-git event families agents should understand

These are not all runtime-owned, but they are central to agent skills.

### Repository

- `30617` repository announcement
- `30618` repository state

### Issues and comments

- `1621` issue
- `1111` NIP-22 comment

### Pull requests

- `1618` pull request
- `1619` pull request update
- `c` identifies the source tip commit; `clone` identifies where that source commit can be fetched when it lives on an orchestrator fork
- `branch-name` is the target branch to merge into, not the worker/source branch

### Status

- `1630` open
- `1631` applied
- `1632` closed
- `1633` draft

### Labels

- `1985` NIP-32 label event

## Reply model

Normal repository replies should use:

- kind `1111`
- NIP-22 root/parent tag semantics

Deprecated reply patterns should not be used by default.

## Skill boundary

Runtime-owned event families:

- `10002`
- `10050` orchestrator DM relay list
- `4444` operator/control-plane DMs to orchestrator
- `30078` token profile sync
- `30002` GRASP preference sync

Skill-driven event families:

- issues
- comments
- labels
- statuses
- PRs

That means agents should not improvise operator control-plane DMs, but they may use Nostr-git issue/comment/label/status/PR events when a task genuinely requires it.

## Source of semantic truth

`openteam` should remain generic.

When exact event semantics are needed for repository events, inspect the active codebase's NIP-22, NIP-32, and NIP-34 implementation rather than hardcoding one app's semantics into `openteam` itself.
