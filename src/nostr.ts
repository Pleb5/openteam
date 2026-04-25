import {finalizeEvent, getPublicKey, nip19, nip44, SimplePool} from "nostr-tools"
import type {Event, Filter} from "nostr-tools"
import {
  D_TAG_GRASP_SERVERS,
  D_TAG_PROFILE_TOKENS,
  KIND_APP_DATA,
  KIND_DM,
  KIND_DM_RELAYS,
  KIND_GRASP_SERVERS,
  KIND_OUTBOX_RELAYS,
} from "./events.js"
import type {PreparedAgent, ProviderCfg, NostrGitCfg, ReportingCfg} from "./types.js"

const pool = new SimplePool({enableReconnect: true})
const DIRECTORY_RELAYS = ["wss://nos.lol", "wss://relay.damus.io", "wss://purplepag.es"]
const recipientRelayCache = new Map<string, { relays: string[]; expiresAt: number }>()
export const PROFILE_SYNC_DELAY_MS = 2000

const uniq = (items: string[]) => Array.from(new Set(items.filter(Boolean)))

const shared = (agent: PreparedAgent): ReportingCfg => agent.app.config.reporting

const sharedGit = (agent: PreparedAgent): NostrGitCfg => agent.app.config.nostr_git

const pick = (value: string[] | undefined, fallback: string[]) => uniq((value?.length ? value : fallback).map(normalizeRelayLikeUrl).filter(isRelayLikeUrl))

const normalizeRelayLikeUrl = (value: string) => value.trim().replace(/\/+$/, "")

const isRelayLikeUrl = (value: string) => {
  try {
    const url = new URL(value)
    return ["ws:", "wss:", "http:", "https:"].includes(url.protocol)
  } catch {
    return false
  }
}

const nowSec = () => Math.floor(Date.now() / 1000)

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

type PublishAttempt = {
  relay: string
  ok: boolean
  message?: string
}

export type PublishSummary = {
  eventId: string
  relays: string[]
  attempts: PublishAttempt[]
}

export type ProfileSyncSummary = {
  kind: "tokens" | "grasp"
  relays: string[]
  meta: Record<string, unknown>
  publish: PublishSummary
}

export type RelayListSyncSummary = {
  kind: "outbox-relays" | "dm-relays"
  relays: string[]
  meta: Record<string, unknown>
  publish: PublishSummary
}

export type RelayListPresence = {
  kind: "outbox-relays" | "dm-relays"
  eventId?: string
  configured: string[]
  published: string[]
  missing: string[]
  relaysChecked: string[]
}

const fromHex = (value: string) => {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("invalid hex secret key")
  }

  const bytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

export const decodeNpub = (npub: string) => {
  const value = nip19.decode(npub)
  if (value.type !== "npub") {
    throw new Error(`expected npub, got ${value.type}`)
  }
  return value.data
}

export const encodeNpub = (pubkey: string) => nip19.npubEncode(pubkey)

export const secretKey = (agent: PreparedAgent) => {
  const value = agent.agent.identity.sec?.trim()
  if (!value) {
    throw new Error(`${agent.id} is missing identity.sec`)
  }

  if (value.startsWith("nsec1")) {
    const decoded = nip19.decode(value)
    if (decoded.type !== "nsec") {
      throw new Error(`expected nsec, got ${decoded.type}`)
    }
    return decoded.data
  }

  return fromHex(value)
}

export const getSelfPubkey = (agent: PreparedAgent) => {
  if (agent.agent.identity.npub) {
    return decodeNpub(agent.agent.identity.npub)
  }
  return getPublicKey(secretKey(agent))
}

export const getSelfNpub = (agent: PreparedAgent) => {
  if (agent.agent.identity.npub) {
    return agent.agent.identity.npub
  }
  return encodeNpub(getSelfPubkey(agent))
}

export const dmRelays = (agent: PreparedAgent) => pick(agent.agent.reporting.dmRelays, shared(agent).dmRelays)

export const outboxRelays = (agent: PreparedAgent) => pick(agent.agent.reporting.outboxRelays, shared(agent).outboxRelays)

export const relayListBootstrapRelays = (agent: PreparedAgent) =>
  pick(agent.agent.reporting.relayListBootstrapRelays, shared(agent).relayListBootstrapRelays)

export const appDataRelays = (agent: PreparedAgent) => pick(agent.agent.reporting.appDataRelays, shared(agent).appDataRelays)

export const signerRelays = (agent: PreparedAgent) => pick(agent.agent.reporting.signerRelays, shared(agent).signerRelays)

export const gitDataRelays = (agent: PreparedAgent) =>
  pick(agent.agent.nostr_git?.gitDataRelays, sharedGit(agent).gitDataRelays)

export const profileRelays = (agent: PreparedAgent) =>
  uniq([...appDataRelays(agent), ...gitDataRelays(agent)])

export const graspServers = (agent: PreparedAgent) =>
  pick(agent.agent.nostr_git?.graspServers, sharedGit(agent).graspServers)

export const allowFrom = (agent: PreparedAgent) => {
  const values = agent.agent.reporting.allowFrom?.length
    ? agent.agent.reporting.allowFrom
    : shared(agent).allowFrom
  return uniq(values)
}

export const relayListPublishRelays = (agent: PreparedAgent) =>
  uniq([...outboxRelays(agent), ...relayListBootstrapRelays(agent)])

export const relayListDiscoveryRelays = (agent: PreparedAgent) =>
  uniq([...outboxRelays(agent), ...relayListBootstrapRelays(agent)])

const conversationKey = (agent: PreparedAgent, pubkey: string) => {
  return nip44.getConversationKey(secretKey(agent), pubkey)
}

export const encryptFor = (agent: PreparedAgent, pubkey: string, body: string) => {
  return nip44.encrypt(body, conversationKey(agent, pubkey))
}

export const decryptFrom = (agent: PreparedAgent, pubkey: string, ciphertext: string) => {
  return nip44.decrypt(ciphertext, conversationKey(agent, pubkey))
}

const authSigner = (sk: Uint8Array) => {
  return async (evt: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(evt, sk)
}

const primeRelayAuth = async (relays: string[], sk?: Uint8Array) => {
  if (!sk) return
  const signer = authSigner(sk)
  await Promise.allSettled(
    uniq(relays).map(async url => {
      const relay = await pool.ensureRelay(url)
      relay.onauth = signer
    }),
  )
}

const describe = (value: unknown) => {
  if (value instanceof Error) return value.message
  return String(value)
}

export const publishEventDetailed = async (
  relays: string[],
  event: Parameters<typeof finalizeEvent>[0],
  sk: Uint8Array,
) => {
  const signed = finalizeEvent(event, sk)
  const targets = uniq(relays)
  await primeRelayAuth(targets, sk)
  const results = await Promise.allSettled(pool.publish(targets, signed, {onauth: authSigner(sk)}))
  const attempts = results.map((result, index) => ({
    relay: targets[index],
    ok: result.status === "fulfilled",
    message: result.status === "fulfilled" ? undefined : describe(result.reason),
  }))

  if (!attempts.some(result => result.ok)) {
    const detail = attempts.map(item => `${item.relay}: ${item.message ?? "publish failed"}`).join("; ")
    throw new Error(`failed to publish to any relay: ${detail}`)
  }

  return {
    eventId: signed.id,
    relays: targets,
    attempts,
  } satisfies PublishSummary
}

export const publishEvent = async (relays: string[], event: Parameters<typeof finalizeEvent>[0], sk: Uint8Array) => {
  const result = await publishEventDetailed(relays, event, sk)
  return {
    ...result,
    eventId: result.eventId,
  }
}

export const queryEvents = async (relays: string[], filter: Filter, sk?: Uint8Array) => {
  const targets = uniq(relays)
  if (targets.length === 0) return []

  await primeRelayAuth(targets, sk)

  return new Promise<any[]>((resolve, reject) => {
    const events: any[] = []
    let settled = false

    pool.subscribeManyEose(targets, filter, {
      maxWait: 4000,
      onauth: sk ? authSigner(sk) : undefined,
      onevent: event => {
        events.push(event)
      },
      onclose: reasons => {
        if (settled) return
        settled = true
        const joined = reasons.join("; ")
        if (events.length === 0 && joined && /auth-required/i.test(joined)) {
          reject(new Error(joined))
          return
        }
        resolve(events)
      },
    })
  })
}

export const subscribeEvents = async (
  relays: string[],
  filter: Filter,
  sk: Uint8Array | undefined,
  onevent: (event: Event) => void,
  onclose?: (reasons: string[]) => void,
) => {
  const targets = uniq(relays)
  if (targets.length === 0) {
    return {
      close: () => {},
    }
  }

  await primeRelayAuth(targets, sk)

  return pool.subscribeMany(targets, filter, {
    onauth: sk ? authSigner(sk) : undefined,
    onevent,
    onclose,
  })
}

const relayTags = (tags: string[][]) => {
  return uniq(tags.filter(tag => tag[0] === "relay" || tag[0] === "r").map(tag => tag[1] ?? ""))
}

const outboxRelayTags = (relays: string[]) => uniq(relays.map(normalizeRelayLikeUrl).filter(isRelayLikeUrl)).map(url => ["r", url] as string[])

const dmRelayTags = (relays: string[]) => uniq(relays.map(normalizeRelayLikeUrl).filter(isRelayLikeUrl)).map(url => ["relay", url] as string[])

const latestOwnRelayList = async (agent: PreparedAgent, kind: number) => {
  const events = await queryEvents(
    relayListDiscoveryRelays(agent),
    {
      kinds: [kind],
      authors: [getSelfPubkey(agent)],
      limit: 20,
    },
    secretKey(agent),
  ).catch(() => [])

  return events.sort((a, b) => b.created_at - a.created_at)[0]
}

const relayPresence = async (
  agent: PreparedAgent,
  kind: number,
  label: RelayListPresence["kind"],
  configured: string[],
): Promise<RelayListPresence> => {
  const event = await latestOwnRelayList(agent, kind)
  const published = event ? relayTags(event.tags) : []
  return {
    kind: label,
    eventId: event?.id,
    configured,
    published,
    missing: configured.filter(url => !published.includes(url)),
    relaysChecked: relayListDiscoveryRelays(agent),
  }
}

const queryAuthorKind = async (agent: PreparedAgent, relays: string[], pubkey: string, kind: number) => {
  if (relays.length === 0) return []
  return queryEvents(relays, {
    kinds: [kind],
    authors: [pubkey],
    limit: 20,
  }, secretKey(agent)).catch(() => [])
}

export const resolveRecipientDmRelays = async (agent: PreparedAgent, recipientPubkey: string) => {
  const cached = recipientRelayCache.get(recipientPubkey)
  const now = Date.now()
  if (cached && cached.expiresAt > now && cached.relays.length > 0) {
    return cached.relays
  }

  const self = dmRelays(agent)
  const hints = uniq([...DIRECTORY_RELAYS, ...self, ...(cached?.relays ?? [])])
  const direct = await queryAuthorKind(agent, hints, recipientPubkey, KIND_DM_RELAYS)
  const outboxEvents = await queryAuthorKind(agent, hints, recipientPubkey, KIND_OUTBOX_RELAYS)
  const outboxRelays = uniq(outboxEvents.flatMap(event => relayTags(event.tags)))
  const viaOutbox = await queryAuthorKind(agent, outboxRelays, recipientPubkey, KIND_DM_RELAYS)
  const merged = [...direct, ...viaOutbox].sort((a, b) => b.created_at - a.created_at)

  for (const event of merged) {
    const relays = relayTags(event.tags)
    if (relays.length === 0) continue
    recipientRelayCache.set(recipientPubkey, {relays, expiresAt: now + 10 * 60_000})
    return relays
  }

  recipientRelayCache.delete(recipientPubkey)
  throw new Error(`recipient ${recipientPubkey} kind ${KIND_DM_RELAYS} inbox relays not found`)
}

export const syncOwnOutboxRelays = async (agent: PreparedAgent) => {
  const configured = outboxRelays(agent)
  const relays = relayListPublishRelays(agent)

  if (configured.length === 0) {
    return {
      kind: "outbox-relays",
      relays,
      meta: {configured, skipped: true},
      publish: {eventId: "", relays, attempts: []},
    } satisfies RelayListSyncSummary
  }

  const publish = await publishEventDetailed(
    relays,
    {
      kind: KIND_OUTBOX_RELAYS,
      created_at: nowSec(),
      tags: outboxRelayTags(configured),
      content: "",
    },
    secretKey(agent),
  )

  return {
    kind: "outbox-relays",
    relays,
    meta: {configured},
    publish,
  } satisfies RelayListSyncSummary
}

export const syncOwnDmRelays = async (agent: PreparedAgent) => {
  const configured = dmRelays(agent)
  const relays = relayListPublishRelays(agent)

  if (configured.length === 0) {
    return {
      kind: "dm-relays",
      relays,
      meta: {configured, skipped: true},
      publish: {eventId: "", relays, attempts: []},
    } satisfies RelayListSyncSummary
  }

  const publish = await publishEventDetailed(
    relays,
    {
      kind: KIND_DM_RELAYS,
      created_at: nowSec(),
      tags: dmRelayTags(configured),
      content: "",
    },
    secretKey(agent),
  )

  return {
    kind: "dm-relays",
    relays,
    meta: {configured},
    publish,
  } satisfies RelayListSyncSummary
}

export const inspectOwnRelayLists = async (agent: PreparedAgent) => {
  const [outbox, dm] = await Promise.all([
    relayPresence(agent, KIND_OUTBOX_RELAYS, "outbox-relays", outboxRelays(agent)),
    relayPresence(agent, KIND_DM_RELAYS, "dm-relays", dmRelays(agent)),
  ])

  return {outbox, dm}
}

export const syncProfileTokens = async (agent: PreparedAgent) => {
  const relays = profileRelays(agent)
  if (relays.length === 0) {
    throw new Error(`${agent.id} is missing profile relays`)
  }

  const tokens = (Object.values(agent.app.config.providers) as ProviderCfg[])
    .filter(item => item.host && item.token)
    .map(item => ({host: item.host, token: item.token}))

  if (tokens.length === 0) {
    throw new Error("no provider tokens configured")
  }

  const pubkey = getSelfPubkey(agent)
  const content = encryptFor(agent, pubkey, JSON.stringify(tokens))
  const publish = await publishEventDetailed(
    relays,
    {
      kind: KIND_APP_DATA,
      created_at: nowSec(),
      tags: [["d", D_TAG_PROFILE_TOKENS]],
      content,
    },
    secretKey(agent),
  )

  return {
    kind: "tokens",
    relays,
    meta: {
      pubkey,
      hosts: tokens.map(item => item.host),
      count: tokens.length,
      standardRelays: appDataRelays(agent),
      gitDataRelays: gitDataRelays(agent),
    },
    publish,
  } satisfies ProfileSyncSummary
}

export const syncGraspServers = async (agent: PreparedAgent) => {
  const relays = profileRelays(agent)
  const urls = graspServers(agent)

  if (relays.length === 0 || urls.length === 0) {
    return {
      kind: "grasp",
      relays,
      meta: {
        urls,
        skipped: true,
      },
      publish: {
        eventId: "",
        relays,
        attempts: [],
      },
    } satisfies ProfileSyncSummary
  }

  const publish = await publishEventDetailed(
    relays,
    {
      kind: KIND_GRASP_SERVERS,
      created_at: nowSec(),
      tags: [["d", D_TAG_GRASP_SERVERS]],
      content: JSON.stringify({urls}),
    },
    secretKey(agent),
  )

  return {
    kind: "grasp",
    relays,
    meta: {
      urls,
      count: urls.length,
      standardRelays: appDataRelays(agent),
      gitDataRelays: gitDataRelays(agent),
    },
    publish,
  } satisfies ProfileSyncSummary
}

export const sendDm = async (agent: PreparedAgent, body: string, recipients?: string[]) => {
  const selfRelays = dmRelays(agent)
  const reportTo = recipients && recipients.length > 0
    ? recipients
    : agent.agent.reporting.reportTo?.length
      ? agent.agent.reporting.reportTo
      : shared(agent).reportTo

  if (selfRelays.length === 0 || reportTo.length === 0) {
    return
  }

  const pubkey = getSelfPubkey(agent)
  const sk = secretKey(agent)

  for (const recipient of uniq(reportTo)) {
    const target = decodeNpub(recipient)
    const recipientRelays = await resolveRecipientDmRelays(agent, target).catch(() => [])
    const publishRelays = uniq([...recipientRelays, ...selfRelays])
    if (publishRelays.length === 0) {
      continue
    }
    await publishEvent(
      publishRelays,
      {
        kind: KIND_DM,
        created_at: nowSec(),
        tags: [["p", target]],
        content: encryptFor(agent, target, body),
      },
      sk,
    )
  }
}

export const sendReport = async (agent: PreparedAgent, body: string, recipients?: string[]) => {
  return sendDm(agent, body, recipients)
}

export const destroyNostr = () => {
  pool.destroy()
}
