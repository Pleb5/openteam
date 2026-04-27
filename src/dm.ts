import type {InboundDm, PreparedAgent} from "./types.js"
import {KIND_DM} from "./events.js"
import {allowFrom, decodeNpub, decryptFrom, dmRelays, encodeNpub, getSelfPubkey, queryEvents, secretKey, subscribeEvents} from "./nostr.js"

type Evt = {
  id: string
  pubkey: string
  created_at: number
  content: string
}

const sortAsc = <T extends {created_at: number}>(items: T[]) => items.sort((a, b) => a.created_at - b.created_at)

export const parseInboundDmEvent = (
  agent: PreparedAgent,
  allowed: Set<string>,
  self: string,
  seen: Set<string>,
  event: Evt,
) => {
  if (seen.has(event.id)) return
  if (event.pubkey === self) return
  if (!allowed.has(event.pubkey)) return

  try {
    const body = decryptFrom(agent, event.pubkey, event.content).trim()
    if (!body) return
    seen.add(event.id)
    return {
      id: event.id,
      fromHex: event.pubkey,
      fromNpub: encodeNpub(event.pubkey),
      createdAt: event.created_at,
      body,
    } satisfies InboundDm
  } catch {
    return
  }
}

export const parseInboundDmEvents = (
  agent: PreparedAgent,
  allowed: Set<string>,
  self: string,
  seen: Set<string>,
  events: Evt[],
) => {
  const messages: InboundDm[] = []
  for (const event of sortAsc(events)) {
    const message = parseInboundDmEvent(agent, allowed, self, seen, event)
    if (message) messages.push(message)
  }
  return messages
}

export const pollInboundTasks = async (
  agent: PreparedAgent,
  since: number,
  seenIds: Set<string>,
): Promise<InboundDm[]> => {
  const relays = dmRelays(agent)
  const allowed = allowFrom(agent)

  if (relays.length === 0 || allowed.length === 0) {
    return []
  }

  const allowedHex = new Set(allowed.map(decodeNpub))
  const selfHex = getSelfPubkey(agent)
  const events = sortAsc(
    await queryEvents(relays, {
      kinds: [KIND_DM],
      "#p": [selfHex],
      since: Math.max(0, since),
    }, secretKey(agent)),
  )

  return parseInboundDmEvents(agent, allowedHex, selfHex, seenIds, events)
}

export const subscribeInboundTasks = async (
  agent: PreparedAgent,
  since: number,
  seenIds: Set<string>,
  onmessage: (message: InboundDm) => void,
  onclose?: (reasons: string[]) => void,
) => {
  const relays = dmRelays(agent)
  const allowed = allowFrom(agent)

  if (relays.length === 0 || allowed.length === 0) {
    return {
      close: () => {},
    }
  }

  const allowedHex = new Set(allowed.map(decodeNpub))
  const selfHex = getSelfPubkey(agent)

  return subscribeEvents(
    relays,
    {
      kinds: [KIND_DM],
      "#p": [selfHex],
      since: Math.max(0, since),
    },
    secretKey(agent),
    event => {
      const message = parseInboundDmEvent(agent, allowedHex, selfHex, seenIds, event as Evt)
      if (message) onmessage(message)
    },
    onclose,
  )
}
