import {existsSync} from "node:fs"
import {spawnSync} from "node:child_process"
import {loadApp, prepareAgent} from "./config.js"
import {assertAppConfigValid, formatConfigValidationIssues, validateAppConfig, type ConfigValidationOptions} from "./config-validate.js"
import {assertControlAllowed} from "./control-guard.js"
import {gitCredentialFromStdin} from "./git-auth.js"
import {browserCommand} from "./commands/browser.js"
import {consolePrompt} from "./commands/console.js"
import {
  acceptsControlDms,
  printRelayPresence,
  profileSyncCommand,
  relaySyncCommand,
} from "./commands/profile.js"
import {repoPolicyCommand, repoPublishCommand} from "./commands/repo-publish.js"
import {serviceCommand} from "./commands/service.js"
import {verifyCommand} from "./commands/verify.js"
import {
  cleanupStaleRunsForContext,
  runsCleanupStale,
  runsDiagnose,
  runsEvidence,
  runsList,
  runsShow,
  readRunRecord,
  stopRunRecord,
} from "./commands/runs.js"
import {createContinuationTaskItem} from "./run-continuation.js"
import {
  evaluateContinuationGate,
  formatContinuationGateError,
  recordContinuationBlock,
  recordContinuationLaunch,
  summarizeContinuationGate,
  writeRunFamilyState,
} from "./run-family-policy.js"
import {runsObserveCommand, runsWatchCommand} from "./run-observer.js"
import {statusReport} from "./commands/status.js"
import {recipientsFromEnv, sourceFromEnv} from "./task-context.js"
import {runTask, enqueueTask, prepareOnly, serveAgent} from "./launcher.js"
import {dispatchOperatorRequest} from "./orchestrator.js"
import {refreshRuntimeStatus} from "./runtime-status.js"
import {listWorkers, startWorker, stopWorker} from "./supervisor.js"
import type {AppCfg, TaskItem, TaskMode} from "./types.js"
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
} from "./nostr.js"

const help = () => {
  console.log(`openteam commands:

  doctor
  status
  console prompt
  prepare <agentId|role>
  launch <agentId|role> --task <text> [--target <nostr-repo|hint|alias>] [--subject-event <nevent|event-id>] [--subject-target <repo>] [--subject-path <path>] [--mode <web|code>] [--model <provider/model>] [--parallel] [--runtime-id <id>]
  enqueue <agentId|role> --task <text> [--target <nostr-repo|hint|alias>] [--subject-event <nevent|event-id>] [--subject-target <repo>] [--subject-path <path>] [--mode <web|code>] [--model <provider/model>]
  serve [agentId|role]   # defaults to orchestrator-01 when omitted
  worker start <agentId|role> [--target <nostr-repo|hint|alias>] [--mode <web|code>] [--model <provider/model>] [--name <worker-name>]
  worker stop <worker-name>
  worker list
  runs list [--limit <n>]
  runs show <run-id> [--raw]
  runs diagnose <run-id> [--json]
  runs evidence <run-id> [--json]
  runs observe <run-id> [--json]
  runs watch [--active|--needs-review] [--once] [--interval-ms <ms>] [--limit <n>] [--json]
  runs continue <run-id> [--task <text>] [--model <provider/model>] [--no-carry-evidence] [--dry-run] [--force]
  runs repair-evidence <run-id> [--task <text>] [--model <provider/model>] [--no-carry-evidence] [--dry-run] [--force]
  runs stop <run-id>
  runs cleanup-stale [--dry-run]
  browser status [agentId|role|worker-name] [--json]
  browser attach <agentId|role|worker-name> [--open] [--json]
  verify list [--checkout <path>] [--json]
  verify run <runner-id> [--checkout <path>] [--json]
  verify record <runner-id> [--state <succeeded|failed|blocked|skipped>] [--type <browser|repo-native|nostr|desktop|mobile|manual>] [--note <text>] [--artifact <path>] [--screenshot <path>] [--url <url>] [--flow <name>] [--event-id <id>] [--checkout <path>]
  verify browser [--state <succeeded|failed|blocked>] [--flow <name>] [--url <url>] [--screenshot <path>] [--console <text>] [--network <text>] [--dev-health] [--checkout <path>]
  verify artifact <path> [--type <browser|repo-native|nostr|desktop|mobile|manual>] [--runner <id>] [--note <text>] [--checkout <path>]
  repo policy [--context <file>] [--agent <agentId|role> --target <nostr-repo|hint|alias>] [--scope <repo|upstream>]
  repo publish raw --event <json-file|-> [--dry-run]
  repo publish issue --subject <text> [--content <text>] [--label <label>] [--p <pubkey>] [--dry-run]
  repo publish comment --root-id <event-id> --root-kind <kind> --content <text> [--root-pubkey <pubkey>] [--dry-run]
  repo publish label --label <label> [--target-id <event-id>] [--namespace <ns>] [--p <pubkey>] [--delete] [--dry-run]
  repo publish role-label --target-id <event-id> --role <assignee|reviewer> --p <pubkey> [--dry-run]
  repo publish status --root-id <event-id> --state <open|applied|closed|draft> [--content <text>] [--dry-run]
  repo publish pr --tip <commit> [--subject <text>] [--clone <url>] [--target-branch <name>] [--draft|--wip] [--dry-run]
  repo publish pr-update --pr-id <event-id> --pr-author <pubkey> --tip <commit> [--draft|--wip] [--dry-run]
  service install|start|stop|restart|status|logs|enable|disable
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

const values = (args: string[], key: string) =>
  args.flatMap((item, index) => item === key ? [args[index + 1] ?? ""] : []).filter(Boolean)

const flag = (args: string[], key: string) => args.includes(key)

const readStdin = async () => {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString("utf8")
}

const must = (value: string, label: string) => {
  if (!value) throw new Error(`missing ${label}`)
  return value
}

const worker = (app: Awaited<ReturnType<typeof loadApp>>, value?: string, fallback = "") => {
  const raw = value || fallback
  if (!raw) throw new Error("missing agentId or role")
  if (app.config.agents[raw]) return raw
  const match = Object.keys(app.config.agents).find(id => app.config.agents[id]?.role === raw)
  if (match) return match
  throw new Error(`unknown agent or role: ${raw}`)
}

const mode = (args: string[]): TaskMode | undefined => {
  const value = args.includes("--mode") ? must(args[args.indexOf("--mode") + 1] ?? "", "--mode") : ""
  if (!value) return undefined
  if (value !== "web" && value !== "code") {
    throw new Error(`invalid --mode ${value}`)
  }
  return value
}

const taskRecipients = (args: string[]) => {
  const recipients = [...values(args, "--recipient"), ...recipientsFromEnv()]
  return recipients.length > 0 ? Array.from(new Set(recipients)) : undefined
}

const taskSource = (args: string[]): TaskItem["source"] | undefined => {
  const envSource = sourceFromEnv()
  const kind = value(args, "--source-kind") || envSource?.kind || ""
  if (!kind) return undefined
  if (kind !== "dm" && kind !== "local" && kind !== "repo-event") {
    throw new Error(`invalid --source-kind ${kind}`)
  }
  return {
    kind,
    eventId: value(args, "--source-event-id") || envSource?.eventId,
    from: value(args, "--source-from") || envSource?.from,
  }
}

const taskSubject = (args: string[]): TaskItem["subject"] | undefined => {
  const eventId = value(args, "--subject-event")
  const repoTarget = value(args, "--subject-target")
  const subjectPath = value(args, "--subject-path")
  if (!eventId && !repoTarget && !subjectPath) return undefined
  if (!eventId) throw new Error("missing --subject-event")
  return {
    kind: "repo-pr-event",
    eventId,
    repoTarget: repoTarget || undefined,
    path: subjectPath || undefined,
  }
}

const taskOpts = (args: string[]): Partial<TaskItem> => ({
  target: value(args, "--target") || undefined,
  mode: mode(args),
  model: value(args, "--model") || undefined,
  runtimeId: value(args, "--runtime-id") || undefined,
  parallel: flag(args, "--parallel") || undefined,
  recipients: taskRecipients(args),
  source: taskSource(args),
  subject: taskSubject(args),
})

const dispatchContext = (args: string[]) => ({
  recipients: taskRecipients(args),
  source: taskSource(args),
})

type CapabilityCheck = {
  label: string
  options: ConfigValidationOptions
}

const defaultAgentMode = (app: AppCfg, agentId: string) =>
  app.config.repos[app.config.agents[agentId]?.repo || ""]?.mode ?? "code"

const capabilityChecks = (app: AppCfg): CapabilityCheck[] => {
  const checks: CapabilityCheck[] = []
  for (const id of Object.keys(app.config.agents)) {
    const defaultMode = defaultAgentMode(app, id)
    checks.push(
      {label: `launch ${id} ${defaultMode}`, options: {capability: "launch", agentId: id, mode: defaultMode}},
      {label: `serve ${id} ${defaultMode}`, options: {capability: "serve", agentId: id, mode: defaultMode}},
      {label: `relay sync ${id}`, options: {capability: "relay-sync", agentId: id}},
      {label: `profile sync ${id}`, options: {capability: "profile-sync", agentId: id}},
      {label: `repo publish ${id}`, options: {capability: "repo-publish", agentId: id}},
    )
  }
  return checks
}

const printCapabilityReadiness = (app: AppCfg) => {
  console.log("capability readiness:")
  for (const check of capabilityChecks(app)) {
    const result = validateAppConfig(app, check.options)
    const state = result.errors.length > 0 ? "blocked" : result.warnings.length > 0 ? "warn" : "ready"
    const details = [...result.errors, ...result.warnings]
      .map(item => `${item.severity}:${item.code}`)
      .join(", ")
    console.log(`  ${check.label}: ${state}${details ? ` (${details})` : ""}`)
  }
}

const doctor = async (app: AppCfg) => {
  const validation = validateAppConfig(app, {capability: "doctor"})
  console.log("config validation:")
  if (validation.issues.length === 0) {
    console.log("  ok")
  } else {
    for (const line of formatConfigValidationIssues(validation.issues)) {
      console.log(`  ${line}`)
    }
  }
  printCapabilityReadiness(app)

  const tools = ["git", "nak", app.config.opencode.binary]
  for (const tool of tools) {
    const result = spawnSync("which", [tool], {encoding: "utf8"})
    console.log(`${tool}: ${result.status === 0 ? result.stdout.trim() : "missing"}`)
  }

  const local = `${app.root}/config/openteam.local.json`
  console.log(`config.local: ${existsSync(local) ? local : "missing"}`)
  for (const id of Object.keys(app.config.agents)) {
    const agent = await prepareAgent(app, id)
    let npub = "(unset)"
    try {
      npub = getSelfNpub(agent)
    } catch {}
    console.log(`${id} workspace: ${agent.paths.workspace}`)
    console.log(`${id} repo contexts: ${app.config.runtimeRoot}/repos/contexts`)
    console.log(`${id} npub: ${npub}`)
    console.log(`${id} outbox relays: ${outboxRelays(agent).length > 0 ? outboxRelays(agent).join(", ") : "(none)"}`)
    console.log(`${id} dm control: ${acceptsControlDms(app, id) ? "enabled" : "disabled"}`)
    if (acceptsControlDms(app, id)) {
      console.log(`${id} dm relays: ${dmRelays(agent).length > 0 ? dmRelays(agent).join(", ") : "(none)"}`)
    }
    console.log(`${id} relay-list bootstrap relays: ${relayListBootstrapRelays(agent).length > 0 ? relayListBootstrapRelays(agent).join(", ") : "(none)"}`)
    console.log(`${id} signer relays: ${signerRelays(agent).length > 0 ? signerRelays(agent).join(", ") : "(none)"}`)
    console.log(`${id} relay-list publish relays: ${relayListPublishRelays(agent).join(", ")}`)
    console.log(`${id} relay-list discovery relays: ${relayListDiscoveryRelays(agent).join(", ")}`)

    try {
      const presence = await inspectOwnRelayLists(agent)
      printRelayPresence(`${id} outbox relay list`, presence.outbox.configured, presence.outbox.published, presence.outbox.missing, presence.outbox.eventId)
      if (acceptsControlDms(app, id)) {
        printRelayPresence(`${id} DM relay list`, presence.dm.configured, presence.dm.published, presence.dm.missing, presence.dm.eventId)
      }
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

  const app = await loadApp()
  assertControlAllowed(cmd)

  if (cmd === "doctor") {
    await doctor(app)
    return
  }

  if (cmd === "console" && sub === "prompt") {
    console.log(await consolePrompt(app))
    return
  }

  if (/^(status|what is running\??)$/i.test(args.join(" ").trim())) {
    console.log(JSON.stringify(await statusReport(app), null, 2))
    return
  }

  if (cmd === "git" && sub === "credential") {
    process.stdout.write(await gitCredentialFromStdin(app, args.slice(2), await readStdin()))
    return
  }

  const known = new Set(["doctor", "console", "prepare", "launch", "enqueue", "serve", "worker", "runs", "browser", "verify", "repo", "service", "relay", "profile", "tokens", "git"])
  if (!known.has(cmd)) {
    const handled = await dispatchOperatorRequest(app, args.join(" "), dispatchContext(args))
    if (handled.handled) {
      console.log(JSON.stringify(handled, null, 2))
      return
    }
  }

  if (cmd === "prepare") {
    const agent = await prepareOnly(app, worker(app, sub))
    console.log(agent.paths.workspace)
    return
  }

  if (cmd === "launch") {
    const task = must(value(args, "--task"), "--task")
    const id = worker(app, sub)
    const opts = taskOpts(args)
    assertAppConfigValid(app, {capability: "launch", agentId: id, mode: opts.mode ?? "web"})
    const result = await runTask(app, id, {
      id: "",
      task,
      createdAt: "",
      state: "queued",
      agentId: id,
      source: {kind: "local"},
      ...opts,
    })
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (cmd === "enqueue") {
    const task = must(value(args, "--task"), "--task")
    const file = await enqueueTask(app, worker(app, sub), task, taskOpts(args))
    console.log(file)
    return
  }

  if (cmd === "serve") {
    const id = worker(app, sub, "orchestrator-01")
    const opts = taskOpts(args)
    assertAppConfigValid(app, {capability: "serve", agentId: id, mode: opts.mode ?? app.config.repos[app.config.agents[id]?.repo || ""]?.mode})
    await serveAgent(app, id, opts)
    return
  }

  if (cmd === "worker" && sub === "start") {
    const roleOrId = must(args[2] ?? "", "agentId|role")
    const agentId = worker(app, roleOrId)
    const opts = taskOpts(args)
    assertAppConfigValid(app, {capability: "serve", agentId, mode: opts.mode ?? app.config.repos[app.config.agents[agentId]?.repo || ""]?.mode})
    const entry = await startWorker(app, {
      agentId,
      role: app.config.agents[agentId]?.role || roleOrId,
      ...opts,
      name: value(args, "--name") || undefined,
    })
    console.log(JSON.stringify(entry, null, 2))
    return
  }

  if (cmd === "worker" && sub === "stop") {
    const name = must(args[2] ?? "", "worker-name")
    const entry = await stopWorker(app, name)
    console.log(JSON.stringify(entry, null, 2))
    return
  }

  if (cmd === "worker" && sub === "list") {
    const workers = await listWorkers(app)
    console.log(JSON.stringify(workers, null, 2))
    return
  }

  if (cmd === "runs" && sub === "list") {
    await runsList(app, args)
    return
  }

  if (cmd === "runs" && sub === "show") {
    await runsShow(app, must(args[2] ?? "", "run-id"), args)
    return
  }

  if (cmd === "runs" && sub === "diagnose") {
    await runsDiagnose(app, must(args[2] ?? "", "run-id"), args)
    return
  }

  if (cmd === "runs" && sub === "evidence") {
    await runsEvidence(app, must(args[2] ?? "", "run-id"), args)
    return
  }

  if (cmd === "runs" && sub === "observe") {
    await runsObserveCommand(app, must(args[2] ?? "", "run-id"), args)
    return
  }

  if (cmd === "runs" && sub === "watch") {
    await runsWatchCommand(app, args)
    return
  }

  if (cmd === "runs" && (sub === "continue" || sub === "repair-evidence")) {
    const record = await readRunRecord(app, must(args[2] ?? "", "run-id"))
    const explicitTask = Boolean(value(args, "--task").trim())
    const item = createContinuationTaskItem(record, {
      kind: sub,
      task: value(args, "--task") || undefined,
      model: value(args, "--model") || undefined,
      carryEvidence: !flag(args, "--no-carry-evidence"),
    })
    const agentId = worker(app, item.agentId)
    assertAppConfigValid(app, {capability: "launch", agentId, mode: item.mode})
    const command = `openteam ${args.join(" ")}`
    const gate = await evaluateContinuationGate(app, record, item, {
      explicitTask,
      force: flag(args, "--force"),
      command,
    })
    if (flag(args, "--dry-run")) {
      console.log(JSON.stringify({agentId, item, gate: summarizeContinuationGate(gate)}, null, 2))
      return
    }
    if (!gate.allowed) {
      recordContinuationBlock(gate)
      await writeRunFamilyState(gate.state)
      throw new Error(formatContinuationGateError(gate))
    }
    recordContinuationLaunch(gate, command)
    await writeRunFamilyState(gate.state)
    if (item.continuation?.contextId) {
      await cleanupStaleRunsForContext(app, item.continuation.contextId)
    }
    console.log(JSON.stringify(await runTask(app, agentId, item), null, 2))
    return
  }

  if (cmd === "runs" && sub === "stop") {
    console.log(JSON.stringify(await stopRunRecord(app, must(args[2] ?? "", "run-id")), null, 2))
    return
  }

  if (cmd === "runs" && (sub === "cleanup-stale" || sub === "reconcile")) {
    const cleaned = await runsCleanupStale(app, args)
    const cleanupAt = new Date().toISOString()
    await refreshRuntimeStatus(app, flag(args, "--dry-run")
      ? {lastCleanupDryRunAt: cleanupAt, lastCleanupCount: cleaned.length}
      : {lastCleanupAt: cleanupAt, lastCleanupCount: cleaned.length})
    return
  }

  if (cmd === "browser") {
    await browserCommand(app, sub, args)
    return
  }

  if (cmd === "verify") {
    await verifyCommand(app, sub, args)
    return
  }

  if (cmd === "repo" && sub === "policy") {
    await repoPolicyCommand(app, args)
    return
  }

  if (cmd === "repo" && sub === "publish") {
    await repoPublishCommand(app, must(args[2] ?? "", "repo publish helper"), args)
    return
  }

  if (cmd === "service") {
    await serviceCommand(app, sub, args)
    return
  }

  if (cmd === "relay" && sub === "sync") {
    assertAppConfigValid(app, {capability: "relay-sync", agentId: must(args[2] ?? "", "agentId")})
    await relaySyncCommand(app, args)
    return
  }

  if ((cmd === "tokens" && sub === "sync") || (cmd === "profile" && sub === "sync")) {
    assertAppConfigValid(app, {capability: "profile-sync", agentId: must(args[2] ?? "", "agentId")})
    await profileSyncCommand(app, args)
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
