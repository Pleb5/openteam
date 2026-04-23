# Relay Model

This document defines every relay bucket used by `openteam`, what each bucket means, and which events are published or read through it.

## Principles

`openteam` separates relay usage by purpose.

Do not collapse all relay traffic into one set.

The buckets exist to keep these concerns separate:

- identity discovery
- DM control plane
- signer transport
- standard app/profile data
- client-specific Nostr-git compatibility

## Relay Buckets

### `outboxRelays`

Meaning:

- the agent's canonical relay identity
- the relay list advertised in the agent's `10002` event

Use:

- publish the agent's `10002` relay list event
- part of relay-list discovery and general identity discoverability

Do not use as:

- DM inbox relay list by default
- bunker transport by default

### `dmRelays`

Meaning:

- the agent's DM inbox and control-plane relays

Use:

- live DM subscription for task intake
- DM fallback polling
- outbound operator-facing DMs

The agent's `10050` event should advertise this set.

### `relayListBootstrapRelays`

Meaning:

- bootstrap/directory relays used to make relay-list events discoverable

Use:

- publish `10002` and `10050` relay-list events to places where new peers can find them
- inspect relay-list visibility during diagnostics

These relays are not the agent's canonical outbox relays.

Examples:

- `wss://relay.damus.io`
- `wss://purplepag.es`

### `appDataRelays`

Meaning:

- the agent's standard app-data/profile relay set

Use:

- publish user-level profile state that is not DM-specific and not signer-specific
- form the generic part of profile sync

This is the generic relay bucket for user-owned app state.

### `signerRelays`

Meaning:

- relays used only by the managed `nak bunker`

Use:

- NIP-46 remote signer transport

Do not use as:

- DM relays
- generic app-data relays
- relay-list identity relays

### `nostr_git.gitDataRelays`

Meaning:

- client-specific compatibility relays for Nostr-git profile data

Use:

- publish profile data to relays where the current Nostr-git client is likely to look for it

This bucket exists because not every client reads user-owned Nostr-git settings from the same relays.

Treat it as a compatibility layer, not a universal relay identity.

### `nostr_git.graspServers`

Meaning:

- GRASP target relays the current client should remember for repo actions

Use:

- sync the GRASP server preference/profile state

These are not DM relays and not signer relays.

## Event Routing Matrix

This is the authoritative routing matrix for current `openteam` behavior.

### Relay-list events

#### `10002` outbox relay list

Advertised contents:

- `outboxRelays`

Publish targets:

- `outboxRelays`
- `relayListBootstrapRelays`

Discovery/inspection targets:

- `outboxRelays`
- `relayListBootstrapRelays`

#### `10050` DM relay list

Advertised contents:

- `dmRelays`

Publish targets:

- `outboxRelays`
- `relayListBootstrapRelays`

Discovery/inspection targets:

- `outboxRelays`
- `relayListBootstrapRelays`

Note:

- the `10050` event describes the DM inbox relays
- it is intentionally not published to `dmRelays` just because they are DM relays

## DM Control Plane

### Inbound DM task intake

Read from:

- `dmRelays`

Mechanics:

- subscription-first
- polling fallback/catch-up

### Outbound operator DMs

Publish to:

- the agent's own `dmRelays`
- the recipient's discovered `10050` inbox relays

This gives redundancy without conflating relay identity with recipient discovery.

## Profile Sync

Profile sync currently covers:

- provider token data
- GRASP server preference

Publish targets:

- `appDataRelays`
- `nostr_git.gitDataRelays`

This is a union because some clients use a generic profile relay set while others still depend on Nostr-git-specific fallback relays.

## Signer Transport

The managed `nak bunker` uses only:

- `signerRelays`

Keep this explicit and deterministic.

Do not silently merge signer traffic into other relay buckets.

## How To Choose Relay Buckets

Use this decision rule:

1. If the event is about relay identity, use relay-list rules.
2. If the event is an operator DM, use DM rules.
3. If the event is generic user profile/app state, use `appDataRelays`.
4. If the event is client-specific Nostr-git profile compatibility, include `nostr_git.gitDataRelays`.
5. If the event is remote signer transport, use `signerRelays` only.

## Recommended Defaults

For a new agent setup:

- `outboxRelays`: one or more stable general relays
- `dmRelays`: one or more relays suitable for DM/control traffic
- `relayListBootstrapRelays`: directory/bootstrap relays
- `appDataRelays`: one or more stable general relays
- `signerRelays`: small stable set for bunker transport
- `nostr_git.gitDataRelays`: current target client's known Nostr-git fallback relays

## Diagnostics

Use:

```bash
bun run src/cli.ts doctor
bun run src/cli.ts relay sync <agentId>
bun run src/cli.ts profile sync <agentId>
```

Interpretation:

- relay-list diagnostics tell you whether `10002` and `10050` are present and discoverable
- profile sync diagnostics tell you where token/grasp profile data was published and whether relays rejected or accepted it

Relay-side failures on some relays do not automatically mean the setup is broken if the required relays accepted the event and diagnostics show no missing relay-list entries.
