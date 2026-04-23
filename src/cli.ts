import {existsSync} from "node:fs"
import {spawnSync} from "node:child_process"
import {loadApp, prepareAgent} from "./config.js"
import {runTask, enqueueTask, prepareOnly, serveAgent} from "./launcher.js"
import {
  destroyNostr,
  dmRelays,
  getSelfNpub,
  inspectOwnRelayLists,
  outboxRelays,
  relayListBootstrapRelays,
  relayListDiscoveryRelays,
  relayListPublishRelays,
  signerRelays,
  syncGraspServers,
  syncProfileTokens,
  syncOwnDmRelays,
  syncOwnOutboxRelays,
  type ProfileSyncSummary,
  type RelayListSyncSummary,
} from "./nostr.js"

const help = () => {
  console.log(`openteam commands:

  doctor
  prepare <agentId>
  launch <agentId> --task <text>
  enqueue <agentId> --task <text>
  serve <agentId>        # poll DMs, ack accepted tasks, run queue
  relay sync <agentId>
  profile sync <agentId>
  tokens sync <agentId>  # alias for profile sync
`)
}

const value = (args: string[], key: string) => {
  const index = args.indexOf(key)
  if (index === -1) return ""
  return args[index + 1] ?? ""
}

const must = (value: string, label: string) => {
  if (!value) throw new Error(`missing ${label}`)
  return value
}

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

const printRelayPresence = (label: string, configured: string[], published: string[], missing: string[], eventId?: string) => {
  console.log(`${label}:`)
  console.log(`  configured: ${configured.length > 0 ? configured.join(", ") : "(none)"}`)
  console.log(`  published: ${published.length > 0 ? published.join(", ") : "(none)"}`)
  console.log(`  missing: ${missing.length > 0 ? missing.join(", ") : "(none)"}`)
  console.log(`  event: ${eventId ?? "(none found)"}`)
}

const doctor = async () => {
  const app = await loadApp()
  const tools = ["git", "nak", app.config.opencode.binary]
  for (const tool of tools) {
    const result = spawnSync("which", [tool], {encoding: "utf8"})
    console.log(`${tool}: ${result.status === 0 ? result.stdout.trim() : "missing"}`)
  }

  const local = `${app.root}/config/openteam.local.json`
  console.log(`config.local: ${existsSync(local) ? local : "missing"}`)
  for (const id of Object.keys(app.config.agents)) {
    const agent = await prepareAgent(app, id)
    console.log(`${id} workspace: ${agent.paths.workspace}`)
    console.log(`${id} worktrees: ${agent.paths.worktrees}`)
    console.log(`${id} npub: ${getSelfNpub(agent)}`)
    console.log(`${id} outbox relays: ${outboxRelays(agent).length > 0 ? outboxRelays(agent).join(", ") : "(none)"}`)
    console.log(`${id} dm relays: ${dmRelays(agent).length > 0 ? dmRelays(agent).join(", ") : "(none)"}`)
    console.log(`${id} relay-list bootstrap relays: ${relayListBootstrapRelays(agent).length > 0 ? relayListBootstrapRelays(agent).join(", ") : "(none)"}`)
    console.log(`${id} signer relays: ${signerRelays(agent).length > 0 ? signerRelays(agent).join(", ") : "(none)"}`)
    console.log(`${id} relay-list publish relays: ${relayListPublishRelays(agent).join(", ")}`)
    console.log(`${id} relay-list discovery relays: ${relayListDiscoveryRelays(agent).join(", ")}`)

    try {
      const presence = await inspectOwnRelayLists(agent)
      printRelayPresence(`${id} outbox relay list`, presence.outbox.configured, presence.outbox.published, presence.outbox.missing, presence.outbox.eventId)
      printRelayPresence(`${id} DM relay list`, presence.dm.configured, presence.dm.published, presence.dm.missing, presence.dm.eventId)
    } catch (error) {
      console.log(`${id} relay-list inspection error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

const main = async () => {
  const args = process.argv.slice(2)
  const [cmd, sub] = args

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    help()
    return
  }

  if (cmd === "doctor") {
    await doctor()
    return
  }

  const app = await loadApp()

  if (cmd === "prepare") {
    const agent = await prepareOnly(app, must(sub, "agentId"))
    console.log(agent.paths.workspace)
    return
  }

  if (cmd === "launch") {
    const task = must(value(args, "--task"), "--task")
    const result = await runTask(app, must(sub, "agentId"), task)
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (cmd === "enqueue") {
    const task = must(value(args, "--task"), "--task")
    const file = await enqueueTask(app, must(sub, "agentId"), task)
    console.log(file)
    return
  }

  if (cmd === "serve") {
    await serveAgent(app, must(sub, "agentId"))
    return
  }

  if (cmd === "relay" && sub === "sync") {
    const id = must(args[2] ?? "", "agentId")
    const agent = await prepareAgent(app, id)
    console.log(`agent: ${id}`)
    console.log(`npub: ${getSelfNpub(agent)}`)
    const outbox = await syncOwnOutboxRelays(agent)
    const dm = await syncOwnDmRelays(agent)
    printRelaySyncSummary(outbox)
    printRelaySyncSummary(dm)
    const presence = await inspectOwnRelayLists(agent)
    printRelayPresence("outbox relay list", presence.outbox.configured, presence.outbox.published, presence.outbox.missing, presence.outbox.eventId)
    printRelayPresence("DM relay list", presence.dm.configured, presence.dm.published, presence.dm.missing, presence.dm.eventId)
    return
  }

  if ((cmd === "tokens" && sub === "sync") || (cmd === "profile" && sub === "sync")) {
    const id = must(args[2] ?? "", "agentId")
    const agent = await prepareAgent(app, id)
    console.log(`agent: ${id}`)
    console.log(`npub: ${getSelfNpub(agent)}`)

    let failed = false

    try {
      const outbox = await syncOwnOutboxRelays(agent)
      const dm = await syncOwnDmRelays(agent)
      printRelaySyncSummary(outbox)
      printRelaySyncSummary(dm)
      const presence = await inspectOwnRelayLists(agent)
      printRelayPresence("outbox relay list", presence.outbox.configured, presence.outbox.published, presence.outbox.missing, presence.outbox.eventId)
      printRelayPresence("DM relay list", presence.dm.configured, presence.dm.published, presence.dm.missing, presence.dm.eventId)
    } catch (error) {
      failed = true
      console.log("step: relay-lists")
      console.log(`  error: ${error instanceof Error ? error.message : String(error)}`)
    }

    try {
      const tokens = await syncProfileTokens(agent)
      printSummary(tokens)
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
    return
  }

  help()
  process.exitCode = 1
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}).finally(() => {
  if (process.argv[2] !== "serve") {
    destroyNostr()
  }
})
