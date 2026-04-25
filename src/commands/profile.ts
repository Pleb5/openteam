import {prepareAgent} from "../config.js"
import {
  getSelfNpub,
  inspectOwnRelayLists,
  sleep,
  PROFILE_SYNC_DELAY_MS,
  syncGraspServers,
  syncProfileTokens,
  syncOwnDmRelays,
  syncOwnOutboxRelays,
  type ProfileSyncSummary,
  type RelayListSyncSummary,
} from "../nostr.js"
import type {AppCfg} from "../types.js"

export const acceptsControlDms = (app: AppCfg, id: string) =>
  app.config.agents[id]?.role === "orchestrator"

const printRelaySyncSummary = (summary: RelayListSyncSummary) => {
  console.log(`step: ${summary.kind}`)
  console.log(`  publish relays: ${summary.relays.length > 0 ? summary.relays.join(", ") : "(none)"}`)
  const configured = Array.isArray(summary.meta.configured) ? summary.meta.configured : []
  console.log(`  configured: ${configured.length > 0 ? configured.join(", ") : "(none)"}`)
  if (summary.meta.skipped) {
    console.log("  status: skipped")
    return
  }
  console.log(`  event id: ${summary.publish.eventId}`)
  for (const attempt of summary.publish.attempts) {
    console.log(`  ${attempt.ok ? "ok" : "fail"}: ${attempt.relay}${attempt.message ? ` (${attempt.message})` : ""}`)
  }
}

const printSummary = (summary: ProfileSyncSummary) => {
  console.log(`step: ${summary.kind}`)
  console.log(`  relays: ${summary.relays.length > 0 ? summary.relays.join(", ") : "(none)"}`)

  const standardRelays = Array.isArray(summary.meta.standardRelays) ? summary.meta.standardRelays : []
  const gitDataRelays = Array.isArray(summary.meta.gitDataRelays) ? summary.meta.gitDataRelays : []
  if (standardRelays.length > 0) {
    console.log(`  standard app-data relays: ${standardRelays.join(", ")}`)
  }
  if (gitDataRelays.length > 0) {
    console.log(`  git-data relays: ${gitDataRelays.join(", ")}`)
  }

  if (summary.kind === "tokens") {
    const hosts = Array.isArray(summary.meta.hosts) ? summary.meta.hosts.join(", ") : "(unknown)"
    console.log(`  token hosts: ${hosts}`)
  }

  if (summary.kind === "grasp") {
    const urls = Array.isArray(summary.meta.urls) ? summary.meta.urls.join(", ") : "(none)"
    console.log(`  grasp servers: ${urls}`)
    if (summary.meta.skipped) {
      console.log("  status: skipped")
      return
    }
  }

  console.log(`  event id: ${summary.publish.eventId}`)
  for (const attempt of summary.publish.attempts) {
    console.log(`  ${attempt.ok ? "ok" : "fail"}: ${attempt.relay}${attempt.message ? ` (${attempt.message})` : ""}`)
  }
}

export const printRelayPresence = (label: string, configured: string[], published: string[], missing: string[], eventId?: string) => {
  console.log(`${label}:`)
  console.log(`  configured: ${configured.length > 0 ? configured.join(", ") : "(none)"}`)
  console.log(`  published: ${published.length > 0 ? published.join(", ") : "(none)"}`)
  console.log(`  missing: ${missing.length > 0 ? missing.join(", ") : "(none)"}`)
  console.log(`  event: ${eventId ?? "(none found)"}`)
}

const must = (value: string, label: string) => {
  if (!value) throw new Error(`missing ${label}`)
  return value
}

export const relaySyncCommand = async (app: AppCfg, args: string[]) => {
  const id = must(args[2] ?? "", "agentId")
  const agent = await prepareAgent(app, id)
  console.log(`agent: ${id}`)
  console.log(`npub: ${getSelfNpub(agent)}`)
  const outbox = await syncOwnOutboxRelays(agent)
  printRelaySyncSummary(outbox)
  if (acceptsControlDms(app, id)) {
    const dm = await syncOwnDmRelays(agent)
    printRelaySyncSummary(dm)
  } else {
    console.log("step: dm-relays")
    console.log("  status: skipped; worker agents do not accept operator DMs")
  }
  const presence = await inspectOwnRelayLists(agent)
  printRelayPresence("outbox relay list", presence.outbox.configured, presence.outbox.published, presence.outbox.missing, presence.outbox.eventId)
  if (acceptsControlDms(app, id)) {
    printRelayPresence("DM relay list", presence.dm.configured, presence.dm.published, presence.dm.missing, presence.dm.eventId)
  }
}

export const profileSyncCommand = async (app: AppCfg, args: string[]) => {
  const id = must(args[2] ?? "", "agentId")
  const agent = await prepareAgent(app, id)
  console.log(`agent: ${id}`)
  console.log(`npub: ${getSelfNpub(agent)}`)

  let failed = false

  try {
    const tokens = await syncProfileTokens(agent)
    printSummary(tokens)
    await sleep(PROFILE_SYNC_DELAY_MS)
  } catch (error) {
    failed = true
    console.log("step: tokens")
    console.log(`  error: ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    const grasp = await syncGraspServers(agent)
    printSummary(grasp)
  } catch (error) {
    failed = true
    console.log("step: grasp")
    console.log(`  error: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (failed) {
    throw new Error(`profile sync failed for ${id}`)
  }

  console.log(`synced profile data for ${id}`)
}
