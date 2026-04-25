import {existsSync} from "node:fs"
import {readFile, readdir, stat} from "node:fs/promises"
import {spawnSync} from "node:child_process"
import path from "node:path"
import {loadApp, prepareAgent} from "./config.js"
import {runTask, enqueueTask, prepareOnly, serveAgent} from "./launcher.js"
import {dispatchOperatorRequest} from "./orchestrator.js"
import {
  buildCommentEvent,
  buildIssueEvent,
  buildLabelEvent,
  buildPullRequestEvent,
  buildPullRequestUpdateEvent,
  buildRoleLabelEvent,
  buildStatusEvent,
  parseRawRepoEvent,
  publishPolicySummary,
  publishRepoEvent,
  repoAddrForPublishTarget,
  resolveRepoPublishTarget,
  type ExtraTags,
  type RepoPublishScope,
} from "./repo-publish.js"
import {listWorkers, startWorker, stopWorker} from "./supervisor.js"
import type {AgentRuntimeState, TaskMode, TaskRunRecord} from "./types.js"
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
  sleep,
  PROFILE_SYNC_DELAY_MS,
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
  console prompt
  prepare <agentId|role>
  launch <agentId|role> --task <text> [--target <nostr-repo|hint|alias>] [--mode <web|code>] [--model <provider/model>] [--parallel] [--runtime-id <id>]
  enqueue <agentId|role> --task <text> [--target <nostr-repo|hint|alias>] [--mode <web|code>] [--model <provider/model>]
  serve [agentId|role]   # defaults to orchestrator-01 when omitted
  worker start <agentId|role> [--target <nostr-repo|hint|alias>] [--mode <web|code>] [--model <provider/model>] [--name <worker-name>]
  worker stop <worker-name>
  worker list
  runs list [--limit <n>]
  runs show <run-id>
  browser status [agentId|role|worker-name] [--json]
  browser attach <agentId|role|worker-name> [--open] [--json]
  repo policy [--context <file>] [--agent <agentId|role> --target <nostr-repo|hint|alias>] [--scope <repo|upstream>]
  repo publish raw --event <json-file|-> [--dry-run]
  repo publish issue --subject <text> [--content <text>] [--label <label>] [--p <pubkey>] [--dry-run]
  repo publish comment --root-id <event-id> --root-kind <kind> --content <text> [--root-pubkey <pubkey>] [--dry-run]
  repo publish label --label <label> [--target-id <event-id>] [--namespace <ns>] [--p <pubkey>] [--delete] [--dry-run]
  repo publish role-label --target-id <event-id> --role <assignee|reviewer> --p <pubkey> [--dry-run]
  repo publish status --root-id <event-id> --state <open|applied|closed|draft> [--content <text>] [--dry-run]
  repo publish pr --tip <commit> [--subject <text>] [--clone <url>] [--branch <name>] [--dry-run]
  repo publish pr-update --pr-id <event-id> --pr-author <pubkey> --tip <commit> [--dry-run]
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

const values = (args: string[], key: string) => {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === key && args[i + 1]) out.push(args[i + 1])
  }
  return out
}

const flag = (args: string[], key: string) => args.includes(key)

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

const taskOpts = (args: string[]) => ({
  target: value(args, "--target") || undefined,
  mode: mode(args),
  model: value(args, "--model") || undefined,
  runtimeId: value(args, "--runtime-id") || undefined,
  parallel: flag(args, "--parallel") || undefined,
})

const scope = (args: string[]): RepoPublishScope | undefined => {
  const raw = value(args, "--scope")
  if (!raw) return undefined
  if (raw !== "repo" && raw !== "upstream") {
    throw new Error(`invalid --scope ${raw}`)
  }
  return raw
}

const repoPublishOpts = (app: Awaited<ReturnType<typeof loadApp>>, args: string[]) => {
  const agentRaw = value(args, "--agent")
  return {
    context: value(args, "--context") || undefined,
    agentId: agentRaw ? worker(app, agentRaw) : undefined,
    target: value(args, "--target") || undefined,
    scope: scope(args),
    dryRun: flag(args, "--dry-run"),
  }
}

const readStdin = async () => new Promise<string>((resolve, reject) => {
  let body = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", chunk => {
    body += chunk
  })
  process.stdin.on("end", () => resolve(body))
  process.stdin.on("error", reject)
})

const readTextArg = async (args: string[], name: string) => {
  const file = value(args, `${name}-file`)
  if (file) {
    return file === "-" ? await readStdin() : await readFile(file, "utf8")
  }
  return value(args, name)
}

const extraTags = (args: string[]): ExtraTags => {
  const fromSpec = values(args, "--tag").map(spec => {
    const index = spec.indexOf("=")
    if (index === -1) throw new Error(`invalid --tag ${spec}; use name=value or name=value1,value2`)
    const name = spec.slice(0, index).trim()
    const raw = spec.slice(index + 1).trim()
    if (!name || !raw) throw new Error(`invalid --tag ${spec}`)
    return [name, ...raw.split(",").map(item => item.trim()).filter(Boolean)]
  })
  const fromJson = values(args, "--tag-json").map(spec => {
    const parsed = JSON.parse(spec)
    if (!Array.isArray(parsed) || !parsed.every(item => typeof item === "string")) {
      throw new Error(`invalid --tag-json ${spec}; expected JSON string array`)
    }
    return parsed as string[]
  })
  return [...fromSpec, ...fromJson]
}

const printRepoPublishResult = (value: unknown) => {
  console.log(JSON.stringify(value, null, 2))
}

const repoPublishEvent = async (app: Awaited<ReturnType<typeof loadApp>>, kind: string, args: string[]) => {
  const opts = repoPublishOpts(app, args)
  const target = await resolveRepoPublishTarget(app, opts)
  const repoAddr = repoAddrForPublishTarget(target)
  const tags = extraTags(args)
  const content = await readTextArg(args, "--content")

  if (kind === "raw") {
    const file = must(value(args, "--event"), "--event")
    const raw = file === "-" ? await readStdin() : await readFile(file, "utf8")
    printRepoPublishResult(await publishRepoEvent(app, parseRawRepoEvent(raw), opts))
    return
  }

  if (kind === "issue") {
    printRepoPublishResult(await publishRepoEvent(app, buildIssueEvent({
      repoAddr,
      subject: must(value(args, "--subject"), "--subject"),
      content,
      labels: values(args, "--label"),
      recipients: values(args, "--p"),
      tags,
    }), opts))
    return
  }

  if (kind === "comment") {
    printRepoPublishResult(await publishRepoEvent(app, buildCommentEvent({
      repoAddr,
      content: must(content, "--content"),
      rootId: must(value(args, "--root-id"), "--root-id"),
      rootKind: must(value(args, "--root-kind"), "--root-kind"),
      rootPubkey: value(args, "--root-pubkey") || undefined,
      rootRelay: value(args, "--root-relay") || undefined,
      parentId: value(args, "--parent-id") || undefined,
      parentKind: value(args, "--parent-kind") || undefined,
      parentPubkey: value(args, "--parent-pubkey") || undefined,
      parentRelay: value(args, "--parent-relay") || undefined,
      tags,
    }), opts))
    return
  }

  if (kind === "label") {
    const labels = values(args, "--label")
    if (labels.length === 0) throw new Error("missing --label")
    printRepoPublishResult(await publishRepoEvent(app, buildLabelEvent({
      repoAddr,
      targetId: value(args, "--target-id") || undefined,
      labels,
      namespace: value(args, "--namespace") || undefined,
      delete: flag(args, "--delete"),
      pubkeys: values(args, "--p"),
      tags,
      content,
    }), opts))
    return
  }

  if (kind === "role-label") {
    const pubkeys = values(args, "--p")
    if (pubkeys.length === 0) throw new Error("missing --p")
    printRepoPublishResult(await publishRepoEvent(app, buildRoleLabelEvent({
      repoAddr,
      rootId: must(value(args, "--target-id"), "--target-id"),
      role: must(value(args, "--role"), "--role"),
      pubkeys,
      namespace: value(args, "--namespace") || undefined,
      content,
    }), opts))
    return
  }

  if (kind === "status") {
    const state = must(value(args, "--state"), "--state")
    printRepoPublishResult(await publishRepoEvent(app, buildStatusEvent({
      repoAddr,
      state: /^\d+$/.test(state) ? Number(state) : state as "open" | "applied" | "closed" | "draft",
      rootId: must(value(args, "--root-id"), "--root-id"),
      content,
      replyId: value(args, "--reply-id") || undefined,
      recipients: values(args, "--p"),
      mergeCommit: value(args, "--merge-commit") || undefined,
      appliedCommits: values(args, "--applied-commit"),
      tags,
    }), opts))
    return
  }

  if (kind === "pr") {
    printRepoPublishResult(await publishRepoEvent(app, buildPullRequestEvent({
      repoAddr,
      subject: value(args, "--subject") || undefined,
      content,
      labels: values(args, "--label"),
      recipients: values(args, "--p"),
      tipCommitOid: must(value(args, "--tip"), "--tip"),
      clone: values(args, "--clone"),
      branchName: value(args, "--branch") || undefined,
      mergeBase: value(args, "--merge-base") || undefined,
      tags,
    }), opts))
    return
  }

  if (kind === "pr-update") {
    printRepoPublishResult(await publishRepoEvent(app, buildPullRequestUpdateEvent({
      repoAddr,
      pullRequestEventId: must(value(args, "--pr-id"), "--pr-id"),
      pullRequestAuthorPubkey: must(value(args, "--pr-author"), "--pr-author"),
      recipients: values(args, "--p"),
      tipCommitOid: must(value(args, "--tip"), "--tip"),
      clone: values(args, "--clone"),
      mergeBase: value(args, "--merge-base") || undefined,
      tags,
    }), opts))
    return
  }

  throw new Error(`unknown repo publish helper: ${kind}`)
}

const runRecordsDir = (app: Awaited<ReturnType<typeof loadApp>>) => path.join(app.config.runtimeRoot, "runs")

const readJsonFile = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, "utf8")) as T

const runsList = async (app: Awaited<ReturnType<typeof loadApp>>, args: string[]) => {
  const dir = runRecordsDir(app)
  if (!existsSync(dir)) {
    console.log("[]")
    return
  }

  const rawLimit = Number.parseInt(value(args, "--limit") || "20", 10)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 20
  const records: Array<{mtimeMs: number; record: TaskRunRecord}> = []

  for (const entry of await readdir(dir)) {
    if (!entry.endsWith(".json")) continue
    const file = path.join(dir, entry)
    try {
      records.push({
        mtimeMs: (await stat(file)).mtimeMs,
        record: await readJsonFile<TaskRunRecord>(file),
      })
    } catch {}
  }

  records.sort((a, b) => b.mtimeMs - a.mtimeMs)
  console.log(JSON.stringify(records.slice(0, limit).map(({record}) => ({
    runId: record.runId,
    state: record.state,
    agentId: record.agentId,
    baseAgentId: record.baseAgentId,
    role: record.role,
    target: record.target,
    mode: record.mode,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    durationMs: record.durationMs,
    contextId: record.context?.id,
    logFile: record.logs?.opencode ?? record.result?.logFile,
    runFile: record.runFile,
  })), null, 2))
}

const runsShow = async (app: Awaited<ReturnType<typeof loadApp>>, id: string) => {
  const fileName = path.basename(id).replace(/\.json$/, "")
  const file = path.join(runRecordsDir(app), `${fileName}.json`)
  if (!existsSync(file)) throw new Error(`run not found: ${id}`)
  process.stdout.write(await readFile(file, "utf8"))
}

const resolveBrowserAgent = async (app: Awaited<ReturnType<typeof loadApp>>, ref: string) => {
  const workers = await listWorkers(app)
  const byWorker = workers.find(worker => worker.name === ref || worker.runtimeId === ref)
  if (byWorker) {
    return {
      ref,
      agentId: byWorker.agentId,
      runtimeId: byWorker.runtimeId ?? byWorker.agentId,
      workerName: byWorker.name,
    }
  }

  const roleMatches = workers.filter(worker => worker.role === ref && worker.running)
  if (roleMatches.length === 1) {
    const match = roleMatches[0]
    return {
      ref,
      agentId: match.agentId,
      runtimeId: match.runtimeId ?? match.agentId,
      workerName: match.name,
    }
  }
  if (roleMatches.length > 1) {
    throw new Error(`multiple live ${ref} jobs found; use one of: ${roleMatches.map(worker => worker.name).join(", ")}`)
  }

  const agentId = worker(app, ref)
  return {ref, agentId, runtimeId: agentId, workerName: undefined}
}

const browserInspection = async (app: Awaited<ReturnType<typeof loadApp>>, ref: string) => {
  const resolved = await resolveBrowserAgent(app, ref)
  const agent = await prepareAgent(app, resolved.agentId, {runtimeId: resolved.runtimeId})
  const state = existsSync(agent.paths.stateFile)
    ? await readJsonFile<AgentRuntimeState>(agent.paths.stateFile)
    : {}
  const browserProfile = state.browserProfile ?? path.join(agent.paths.browser, "profile")
  const browserArtifacts = state.browserArtifacts ?? path.join(agent.paths.artifacts, "playwright")
  const url = state.url ?? ""
  const liveWebRun = Boolean(state.running && state.mode === "web" && url)
  return {
    agentId: agent.id,
    baseAgentId: agent.configId,
    runtimeId: agent.id,
    workerName: resolved.workerName,
    role: agent.agent.role,
    running: Boolean(state.running),
    liveWebRun,
    taskId: state.taskId,
    target: state.target,
    mode: state.mode,
    url,
    checkout: state.checkout,
    logFile: state.logFile,
    runId: state.runId,
    runFile: state.runFile,
    durationMs: state.durationMs,
    browserHeadless: state.browserHeadless ?? app.config.browser.headless,
    browserProfile,
    browserArtifacts,
    browserExecutable: app.config.browser.executablePath || "chromium",
    commands: {
      openUrl: liveWebRun ? `xdg-open ${url}` : undefined,
      tailLog: state.logFile ? `tail -f ${state.logFile}` : undefined,
      openProfileAfterRun: `${app.config.browser.executablePath || "chromium"} --user-data-dir ${browserProfile}`,
    },
  }
}

const printBrowserInspection = (info: Awaited<ReturnType<typeof browserInspection>>) => {
  console.log(`agent: ${info.agentId}`)
  console.log(`base agent: ${info.baseAgentId}`)
  console.log(`runtime id: ${info.runtimeId}`)
  console.log(`worker: ${info.workerName ?? "(none)"}`)
  console.log(`role: ${info.role}`)
  console.log(`running: ${info.running ? "yes" : "no"}`)
  console.log(`live web run: ${info.liveWebRun ? "yes" : "no"}`)
  console.log(`task: ${info.taskId ?? "(none)"}`)
  console.log(`target: ${info.target ?? "(none)"}`)
  console.log(`mode: ${info.mode ?? "(none)"}`)
  console.log(`url: ${info.url || "(none)"}`)
  console.log(`checkout: ${info.checkout ?? "(none)"}`)
  console.log(`log: ${info.logFile ?? "(none)"}`)
  console.log(`run: ${info.runId ?? "(none)"}`)
  console.log(`run file: ${info.runFile ?? "(none)"}`)
  console.log(`browser headless: ${info.browserHeadless ? "yes" : "no"}`)
  console.log(`browser profile: ${info.browserProfile}`)
  console.log(`playwright artifacts: ${info.browserArtifacts}`)
  if (info.commands.openUrl) console.log(`open current app URL: ${info.commands.openUrl}`)
  if (info.commands.tailLog) console.log(`tail worker log: ${info.commands.tailLog}`)
  console.log(`open worker profile after run: ${info.commands.openProfileAfterRun}`)
  if (info.liveWebRun) {
    console.log("note: do not open the worker profile while Playwright is using it; use the URL/log/artifacts for live observation.")
  }
}

const browserCommand = async (app: Awaited<ReturnType<typeof loadApp>>, sub: string | undefined, args: string[]) => {
  const json = flag(args, "--json")

  if (sub === "status") {
    const raw = args[2]
    const refs = raw && !raw.startsWith("--")
      ? [raw]
      : [
        ...Object.keys(app.config.agents),
        ...(await listWorkers(app)).map(worker => worker.name),
      ]
    const items = await Promise.all(Array.from(new Set(refs)).map(ref => browserInspection(app, ref)))
    if (json) {
      console.log(JSON.stringify(items, null, 2))
      return
    }
    for (const [index, item] of items.entries()) {
      if (index > 0) console.log("")
      printBrowserInspection(item)
    }
    return
  }

  if (sub === "attach") {
    const id = must(args[2] ?? "", "agentId|role|worker-name")
    const info = await browserInspection(app, id)
    if (json) {
      console.log(JSON.stringify(info, null, 2))
    } else {
      printBrowserInspection(info)
    }
    if (flag(args, "--open")) {
      if (!info.liveWebRun || !info.url) throw new Error(`no live dev URL for ${id}`)
      const result = spawnSync("xdg-open", [info.url], {stdio: "inherit"})
      if (result.status !== 0) throw new Error(`xdg-open exited with code ${result.status ?? -1}`)
    }
    return
  }

  throw new Error("expected browser status|attach")
}

const acceptsControlDms = (app: Awaited<ReturnType<typeof loadApp>>, id: string) =>
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

const printRelayPresence = (label: string, configured: string[], published: string[], missing: string[], eventId?: string) => {
  console.log(`${label}:`)
  console.log(`  configured: ${configured.length > 0 ? configured.join(", ") : "(none)"}`)
  console.log(`  published: ${published.length > 0 ? published.join(", ") : "(none)"}`)
  console.log(`  missing: ${missing.length > 0 ? missing.join(", ") : "(none)"}`)
  console.log(`  event: ${eventId ?? "(none found)"}`)
}

const consolePrompt = async (app: Awaited<ReturnType<typeof loadApp>>) => {
  const workers = await listWorkers(app)
  const shared = app.config.reporting
  const git = app.config.nostr_git
  const forkProviders = Object.values(app.config.providers)
    .filter(provider => provider.token && (provider.type === "github" || provider.type === "gitlab" || ["github.com", "gitlab.com"].includes(provider.host)))
    .map(provider => `${provider.type || provider.host}:${provider.host}`)
  let orchestratorNpub = "(unset)"
  try {
    orchestratorNpub = getSelfNpub(await prepareAgent(app, "orchestrator-01"))
  } catch {}

  const workerLines = workers.length === 0
    ? ["- no managed workers currently running"]
    : workers.map(worker => `- ${worker.name}: role=${worker.role}, runtime=${worker.runtimeId ?? worker.agentId}, target=${worker.target ?? "(none)"}, mode=${worker.mode ?? "(unset)"}, parallel=${worker.parallel ? "yes" : "no"}, running=${worker.running ? "yes" : "no"}`)

  return [
    "You are orchestrator-01, the primary operator-facing control plane for openteam.",
    "Use the orchestrator-control skill and the local openteam CLI control surface to manage workers.",
    "Never directly do repository implementation work yourself. Always delegate implementation, triage, and QA to worker agents.",
    "Preferred operator request verbs: status, stop <worker>, start <role> on <target>, watch <target> as <role>, work on <target> [as <role>] [in <mode> mode] [with model <model>] and do <task>.",
    "For same-repo concurrent work, use the explicit form: work on <target> ... in parallel and do <task>.",
    "When a request is clear, dispatch it using the local CLI instead of inventing an ad hoc control path.",
    "If an operator asks you to finish or fix something, treat that as a request to choose and launch the right worker rather than doing the implementation yourself.",
    "For observability, use `openteam runs list`, `openteam runs show <run-id>`, and `openteam browser attach <agent|role|worker-name>` instead of ad hoc log hunting.",
    "Shared relay defaults:",
    `- dmRelays: ${shared.dmRelays.join(", ") || "(none)"}`,
    `- outboxRelays: ${shared.outboxRelays.join(", ") || "(none)"}`,
    `- relayListBootstrapRelays: ${shared.relayListBootstrapRelays.join(", ") || "(none)"}`,
    `- appDataRelays: ${shared.appDataRelays.join(", ") || "(none)"}`,
    `- signerRelays: ${shared.signerRelays.join(", ") || "(none)"}`,
    `- graspServers: ${git.graspServers.join(", ") || "(none)"}`,
    `- gitDataRelays: ${git.gitDataRelays.join(", ") || "(none)"}`,
    `- repoAnnouncementRelays: ${git.repoAnnouncementRelays.join(", ") || "(none)"}`,
    `- repo announcement owner: orchestrator-01 (${orchestratorNpub})`,
    `- fork providers: ${forkProviders.join(", ") || "(none)"}`,
    `- forkGitOwner: ${git.forkGitOwner || "(optional fallback when clone URL lacks owner npub/pubkey path segment)"}`,
    `- forkCloneUrlTemplate: ${git.forkCloneUrlTemplate || "(optional explicit override)"}`,
    "When an outside-owned repo is targeted, create or reuse an orchestrator-owned kind 30617 fork. Default fork storage priority is GitHub, then GitLab, then GRASP.",
    "When GRASP stores the fork, the fork announcement relays tag must include the GRASP relay URL derived from the GRASP smart-HTTP clone URL.",
    "Current managed workers:",
    ...workerLines,
    "Ask clarifying questions when target, role, mode, or model is ambiguous. Prefer safe execution for operator requests and explicit confirmation only for disruptive actions.",
  ].join("\n")
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

  if (cmd === "doctor") {
    await doctor()
    return
  }

  if (cmd === "console" && sub === "prompt") {
    console.log(await consolePrompt(app))
    return
  }

  const known = new Set(["doctor", "console", "prepare", "launch", "enqueue", "serve", "worker", "runs", "browser", "repo", "relay", "profile", "tokens"])
  if (!known.has(cmd)) {
    const handled = await dispatchOperatorRequest(app, args.join(" "))
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
    const result = await runTask(app, id, {
      id: "",
      task,
      createdAt: "",
      state: "queued",
      agentId: id,
      source: {kind: "local"},
      ...taskOpts(args),
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
    await serveAgent(app, id, taskOpts(args))
    return
  }

  if (cmd === "worker" && sub === "start") {
    const roleOrId = must(args[2] ?? "", "agentId|role")
    const agentId = worker(app, roleOrId)
    const entry = await startWorker(app, {
      agentId,
      role: app.config.agents[agentId]?.role || roleOrId,
      ...taskOpts(args),
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
    await runsShow(app, must(args[2] ?? "", "run-id"))
    return
  }

  if (cmd === "browser") {
    await browserCommand(app, sub, args)
    return
  }

  if (cmd === "repo" && sub === "policy") {
    const target = await resolveRepoPublishTarget(app, repoPublishOpts(app, args))
    printRepoPublishResult(publishPolicySummary(target))
    return
  }

  if (cmd === "repo" && sub === "publish") {
    await repoPublishEvent(app, must(args[2] ?? "", "repo publish helper"), args)
    return
  }

  if (cmd === "relay" && sub === "sync") {
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
    return
  }

  if ((cmd === "tokens" && sub === "sync") || (cmd === "profile" && sub === "sync")) {
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
