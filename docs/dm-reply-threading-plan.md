# DM Reply Threading Plan

This plan replaces implicit conversational state with Nostr reply structure.
The goal is to let operator DMs feel natural without adding a pending-action state machine.

## Reference Model

Budabit room replies use a selected parent event before publish:

- `~/Work/budabit/src/routes/spaces/[relay]/[h]/+page.svelte` stores a `parent` event when the user clicks reply.
- On submit, it calls `prependParent(parent, template)`.
- `~/Work/budabit/src/app/core/commands.ts` builds a `nostr:nevent...` pointer and adds a quote/reference tag with `tagEventForQuote(parent)`.
- Welshman also exposes `tagEventForReply`, which builds explicit `e` root/reply marker tags.

For openteam DMs, use the same idea but make reply tags the source of truth.

## Design Rules

- Fast grammar remains first: `help`, `status`, `stop`, `start`, `watch`, `research`, `plan`, `work on ... and do ...`.
- If fast grammar does not match, freeform DM fallback receives deterministic reply context from Nostr tags.
- No pending-action table.
- No broad chat-memory guessing.
- No global “last thing the operator probably meant” inference.
- Triggered run observation messages stay unthreaded.
- Direct answers to operator messages are threaded replies.

## Event Shape

### Inbound Operator DM

Parse and retain:

- event id
- pubkey / npub
- created_at
- decrypted body
- tags
- extracted reply parent, if present

Reply parent extraction order:

1. `e` tag with marker `reply`
2. `e` tag with marker `root`
3. `q` tag
4. optional fallback: leading `nostr:nevent...` in decrypted content

### Outbound Reply DM

When openteam is answering a specific operator DM, publish a DM with:

```ts
["p", operatorPubkey]
["e", parentEventId, relayHint, "reply", parentPubkey]
```

Optionally also add:

```ts
["q", parentEventId, relayHint, parentPubkey]
```

Use `e` reply tags as the canonical threading signal.
Use `q` only for client compatibility if needed.

Do not prepend a `nostr:nevent...` URI into encrypted DM content unless a target client proves it needs that for display.

### Outbound Observation DM

Run observations are not replies.
They should keep no parent tag and rely on content handles:

```text
[builder-01] warning ...
run: builder-01-...
target: ...
```

This prevents asynchronous lifecycle reports from hijacking the operator's current reply chain.

## Local State

Add a bounded DM event cache under the orchestrator runtime state, for example:

```text
runtime/orchestrator/dm-events.json
```

Store only operational metadata and decrypted bodies needed for context reconstruction:

```ts
type DmEventRecord = {
  id: string
  direction: "inbound" | "outbound"
  pubkey: string
  npub: string
  createdAt: number
  body: string
  tags: string[][]
  replyTo?: {
    id: string
    pubkey?: string
    relay?: string
  }
}
```

Retention should be bounded by count and age, for example last 500 events or 14 days.

## Context Reconstruction

For a current inbound DM:

1. Load its direct reply parent from tags.
2. Resolve that parent from the local DM cache.
3. If the parent is an outbound openteam reply, include one more parent when present.
4. Stop there.

This gives a shallow deterministic thread:

```text
parent-of-parent, optional
parent
current operator message
```

No deeper recursion is needed for the first implementation.

## Freeform Prompt Contract

When freeform fallback runs, pass:

- current operator message
- direct parent message, if resolved
- optional grandparent message, only when parent is an openteam reply
- current managed workers
- recent run summary

The prompt should explicitly say:

- the reply chain is authoritative context
- unthreaded observation messages are background status, not conversation turns
- if the current message is ambiguous and no parent exists, ask a concise clarification

## Runtime Reporting

Replace wrapper text like:

```text
[orchestrator-01] succeeded freeform request ...
```

with one of:

```text
Need clarification
Started job
Continued run
No action taken
Status
```

For threaded direct answers, send the assistant answer as a reply to the triggering operator DM.

## Implementation Steps

1. Extend `InboundDm` to include raw `tags` and extracted `replyTo`.
2. Add `src/dm-thread.ts` with helpers:
   - `extractDmReplyRef(tags, content)`
   - `dmReplyTags(parent)`
   - `recordDmEvent(...)`
   - `resolveDmContext(...)`
3. Change `sendDm` / `sendReport` to accept optional `{replyTo}` metadata and return published event ids.
4. Record inbound DMs before enqueueing work.
5. Record outbound DMs after publish.
6. Reply-thread `working on it`, fast grammar responses, clarification replies, and freeform answers.
7. Keep observation reports unthreaded.
8. Feed reconstructed reply context into conversational fallback.
9. Add tests for:
   - reply tag extraction
   - outbound reply tag construction
   - no reply tags on observation reports
   - freeform context from direct parent
   - shallow parent-of-parent reconstruction

## Expected Behavior

Operator sends:

```text
can next focus on repairing the researcher runtime and then relaunch the comparison
```

Orchestrator replies directly to that DM:

```text
I can do that. Reply with the target or run id if you want a continuation; otherwise I can launch a researcher task.
```

Operator replies to that orchestrator DM:

```text
Please do
```

openteam reconstructs the thread from reply tags and treats `Please do` in the context of the parent message.

If an unrelated run warning arrives between those messages, it is unthreaded and does not affect this context.
