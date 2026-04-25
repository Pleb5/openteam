# Relay Model

This document defines every relay bucket used by `openteam`, what each bucket means, and which events are published or read through it.

## Principles

`openteam` separates relay usage by purpose.

The default configuration model is shared-first:

- top-level relay buckets are the primary source
- worker identities inherit those buckets by default
- worker-specific overrides exist only for exceptional cases

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

- the orchestrator's DM inbox and control-plane relays

Use:

- live orchestrator DM subscription for task intake
- orchestrator DM fallback polling
- outbound operator-facing DMs

Only the orchestrator's `10050` event should advertise this set.
Worker agents do not accept operator instructions by DM.

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
- fallback Git smart-HTTP storage targets for orchestrator-owned forks

Use:

- store the GRASP server URL list inside the GRASP server preference/profile event
- provide fallback fork storage when GitHub/GitLab provider targets are unavailable
- when used for fork storage, derive both the smart-HTTP clone URL and the NIP-34 repo `relays` tag entry from the same GRASP server

Do not use as:

- publish targets for GRASP server preference/profile events
- generic profile/app-data relays
- DM relays
- signer relays

GRASP server preference/profile events are published to `appDataRelays + nostr_git.gitDataRelays`.
The GRASP server URLs are event content/config values, not the relay bucket for publishing that event.

### `nostr_git.repoAnnouncementRelays`

Meaning:

- fallback relays used to discover kind `30617` Nostr repository announcements
- fallback repo relays for non-GRASP repo-scoped events

Use:

- resolve operator target hints to canonical Nostr repo identities before any clone/provision step
- supplement direct `nostr://<owner-npub>/<repo-d-tag>` resolution after checking relay hints and the owner's kind `10002` outbox relays
- discover existing orchestrator-owned fork announcements
- publish non-GRASP openteam-created fork announcements
- cache discovered repo identity in `runtime/repos/registry.json`

Do not use as:

- operator DM relays
- signer relays
- a substitute for repo-scoped workflow relays from the announcement itself

### Repository Relay Policy

For active repository events, openteam follows the same split used by the reference Nostr-git client:

- GRASP-backed repos: repo relays, publish relays, and naddr relays are exactly the `relays` tag values from the repo event
- non-GRASP repos: repo relays are tagged repo relays plus direct target relay hints plus `nostr_git.repoAnnouncementRelays`
- non-GRASP publish/naddr relays: repo relays plus orchestrator `outboxRelays` plus `nostr_git.gitDataRelays`

Discovery may use a broader relay set, but repo-event writes must not silently add `appDataRelays`, `relayListBootstrapRelays`, or untagged GRASP relays.

Managed repo contexts write `.openteam/repo-context.json`.
Workers should use `openteam repo policy` to inspect the active policy and `openteam repo publish ...` for repo-side issue/comment/label/status/PR writes.
The context records the default publish scope; repository-event triage can default to `upstream`, while implementation work defaults to the managed working repo.

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
- it is orchestrator-only
- it is intentionally not published to `dmRelays` just because they are DM relays

## DM Control Plane

### Inbound DM task intake

Read from:

- `dmRelays`

Mechanics:

- subscription-first
- polling fallback/catch-up
- orchestrator-only; workers never accept instructions through this path

### Outbound operator DMs

Publish to:

- the orchestrator's own `dmRelays`
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
2. If the event is an operator DM, use DM rules and route it only to/from the orchestrator.
3. If the event is Nostr repository announcement discovery, use the broad discovery relay set.
4. If the event is repo-scoped Nostr-git data, use the repository relay policy.
5. If the event is generic user profile/app state, use `appDataRelays`.
6. If the event is client-specific Nostr-git profile compatibility, include `nostr_git.gitDataRelays`.
7. If the event is remote signer transport, use `signerRelays` only.

## Recommended Defaults

For a new agent setup:

- `outboxRelays`: one or more stable general relays
- `dmRelays`: one or more relays suitable for DM/control traffic
- `relayListBootstrapRelays`: directory/bootstrap relays
- `appDataRelays`: one or more stable general relays
- `signerRelays`: small stable set for bunker transport
- `nostr_git.gitDataRelays`: current target client's known Nostr-git fallback relays
- `nostr_git.repoAnnouncementRelays`: current target client's known repository announcement relays

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
