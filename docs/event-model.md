# Event Model

This document records the current Nostr event model used by `openteam` runtime behavior.

It focuses on runtime-owned events and the event families agents are expected to understand.

## Runtime-owned events

These events are handled by `openteam` itself, not by ad hoc agent improvisation.

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
- publish targets: `outboxRelays + relayListBootstrapRelays`

Purpose:

- advertise where the agent expects DM/control-plane traffic

## DM control-plane events

### Operator task DMs

- kind: `4444`

Use:

- inbound task intake
- immediate acknowledgement
- completion/blocker reporting

Read path:

- subscription-first on `dmRelays`
- polling fallback on `dmRelays`

Write path:

- own `dmRelays`
- recipient-discovered `10050` inbox relays

Encryption:

- NIP-44

Signing:

- agent identity secret / managed bunker-backed identity model

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
- `10050`
- `4444` operator/control-plane DMs
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
