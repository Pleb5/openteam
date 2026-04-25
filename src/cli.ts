import {existsSync} from "node:fs"
import {readFile, readdir, stat, writeFile} from "node:fs/promises"
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
import {loadRepoRegistry, releaseRepoContext} from "./repo.js"
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
  status
  console prompt
  prepare <agentId|role>
  launch <agentId|role> --task <text> [--target <nostr-repo|hint|alias>] [--mode <web|code>] [--model <provider/model>] [--parallel] [--runtime-id <id>]
  enqueue <agentId|role> --task <text> [--target <nostr-repo|hint|alias>] [--mode <web|code>] [--model <provider/model>]
  serve [agentId|role]   # defaults to orchestrator-01 when omitted
  worker start <agentId|role> [--target <nostr-repo|hint|alias>] [--mode <web|code>] [--model <provider/model>] [--name <worker-name>]
  worker stop <worker-name>
  worker list
  runs list [--limit <n>]
  runs show <run-id> [--raw]
  runs diagnose <run-id> [--json]
  runs stop <run-id>
  runs cleanup-stale [--dry-run]
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

const assertControlAllowed = (cmd: string) => {
  if (process.env.OPENTEAM_PHASE !== "provision") return
  const blocked = new Set(["launch", "enqueue", "serve", "worker"])
  if (blocked.has(cmd) || !["doctor", "status", "console", "prepare", "runs", "browser", "repo", "relay", "profile", "tokens"].includes(cmd)) {
    throw new Error("worker-control commands are disabled during repository provisioning")
  }
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

const recentRunRecords = async (app: Awaited<ReturnType<typeof loadApp>>, limit: number) => {
  const dir = runRecordsDir(app)
  if (!existsSync(dir)) {
    return []
  }

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
  return records.slice(0, limit)
}

const summarizeRuns = async (app: Awaited<ReturnType<typeof loadApp>>, records: Array<{record: TaskRunRecord}>) =>
  Promise.all(records.map(async ({record}) => {
    const diagnosis = record.state === "running" || record.state === "stale"
      ? await diagnoseRun(app, record).catch(() => undefined)
      : undefined
    return runListView(record, diagnosis)
  }))

const runsList = async (app: Awaited<ReturnType<typeof loadApp>>, args: string[]) => {
  const rawLimit = Number.parseInt(value(args, "--limit") || "20", 10)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 20
  const summaries = await summarizeRuns(app, await recentRunRecords(app, limit))
  console.log(JSON.stringify(summaries, null, 2))
}

const runsShow = async (app: Awaited<ReturnType<typeof loadApp>>, id: string, args: string[]) => {
  const fileName = path.basename(id).replace(/\.json$/, "")
  const file = path.join(runRecordsDir(app), `${fileName}.json`)
  if (!existsSync(file)) throw new Error(`run not found: ${id}`)
  if (flag(args, "--raw")) {
    process.stdout.write(await readFile(file, "utf8"))
    return
  }
  const record = await readJsonFile<TaskRunRecord>(file)
  const diagnosis = await diagnoseRun(app, record)
  console.log(JSON.stringify(runShowView(record, diagnosis), null, 2))
}

const runRecordFile = (app: Awaited<ReturnType<typeof loadApp>>, id: string) => {
  const fileName = path.basename(id).replace(/\.json$/, "")
  return path.join(runRecordsDir(app), `${fileName}.json`)
}

const readRunRecord = async (app: Awaited<ReturnType<typeof loadApp>>, id: string) => {
  const file = runRecordFile(app, id)
  if (!existsSync(file)) throw new Error(`run not found: ${id}`)
  return readJsonFile<TaskRunRecord>(file)
}

const writeRunRecord = async (record: TaskRunRecord) => {
  await writeFile(record.runFile, `${JSON.stringify(record, null, 2)}\n`)
}

const nowIso = () => new Date().toISOString()
const STALE_NO_ACTIVITY_MS = 10 * 60_000

const pidAlive = (pid?: number) => {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const pidMap = (record: TaskRunRecord) => {
  const entries = Object.entries(record.process ?? {}) as Array<[string, number | undefined]>
  return Object.fromEntries(entries.map(([name, pid]) => [name, {pid, alive: pidAlive(pid)}]))
}

const runPids = (record: TaskRunRecord) =>
  Array.from(new Set(Object.values(record.process ?? {}).filter((pid): pid is number => typeof pid === "number" && pid > 0)))

const taskPids = (record: TaskRunRecord) =>
  Array.from(new Set([
    record.process?.provisionPid,
    record.process?.opencodePid,
    record.process?.devPid,
  ].filter((pid): pid is number => typeof pid === "number" && pid > 0)))

const latestRunningPhase = (record: TaskRunRecord) =>
  [...record.phases].reverse().find(phase => phase.state === "running")

const logInfo = async (file?: string) => {
  if (!file || !existsSync(file)) return undefined
  const info = await stat(file)
  return {
    file,
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
    ageMs: Date.now() - info.mtimeMs,
  }
}

const checkUrl = async (url?: string) => {
  if (!url) return {ok: false, url, error: "no url"}
  const attempt = async (method: "HEAD" | "GET") => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1500)
    try {
      const response = await fetch(url, {method, signal: controller.signal})
      return {ok: response.status >= 200 && response.status < 500, url, status: response.status, method}
    } catch (error) {
      return {ok: false, url, method, error: error instanceof Error ? error.message : String(error)}
    } finally {
      clearTimeout(timer)
    }
  }
  const head = await attempt("HEAD")
  if (head.ok || (head.status && head.status !== 405 && head.status !== 501)) return head
  const get = await attempt("GET")
  return {...get, head}
}

const diagnoseRun = async (app: Awaited<ReturnType<typeof loadApp>>, record: TaskRunRecord) => {
  const registry = await loadRepoRegistry(app)
  const context = record.context?.id ? registry.contexts[record.context.id] : undefined
  const processes = pidMap(record)
  const knownPids = runPids(record)
  const anyPidAlive = knownPids.some(pidAlive)
  const knownTaskPids = taskPids(record)
  const anyTaskPidAlive = knownTaskPids.some(pidAlive)
  const health = await checkUrl(record.browser?.url || record.devServer?.url || record.result?.url)
  const runningPhase = latestRunningPhase(record)
  const logs = {
    opencode: await logInfo(record.logs?.opencode),
    provision: await logInfo(record.logs?.provision),
    dev: await logInfo(record.logs?.dev),
  }
  const newestLogAgeMs = Math.min(...Object.values(logs).map(item => item?.ageMs).filter((age): age is number => typeof age === "number"))
  const runAgeMs = Math.max(0, Date.now() - Date.parse(record.startedAt))
  const recentActivity = Number.isFinite(newestLogAgeMs)
    ? newestLogAgeMs < STALE_NO_ACTIVITY_MS
    : runAgeMs < STALE_NO_ACTIVITY_MS
  const contextLeaseMatchesRun = Boolean(
    context?.lease &&
    context.lease.workerId === record.agentId &&
    context.lease.jobId === record.taskId,
  )
  const reasons: string[] = []

  if (record.state === "stale") {
    reasons.push("run has already been marked stale")
  }

  if (record.state === "running") {
    if (knownPids.length === 0) {
      reasons.push("run is marked running but has no recorded process pids")
    } else if (!anyPidAlive) {
      reasons.push("run is marked running but all recorded process pids are dead")
    }

    if (knownPids.length > 0 && knownTaskPids.length === 0 && !recentActivity) {
      reasons.push("run has no task-specific child pid evidence and no recent log activity")
    } else if (knownTaskPids.length > 0 && !anyTaskPidAlive && !recentActivity) {
      reasons.push("all task-specific child pids are dead and no recent log activity was observed")
    }

    if ((record.mode === "web" || record.browser?.url) && !health.ok) {
      reasons.push("run advertises a browser/dev URL but the URL is not healthy")
    }
  }

  if (context?.state === "leased" && record.state !== "running" && contextLeaseMatchesRun) {
    reasons.push("repo context is still leased after run finished")
  }

  const staleCandidate = record.state === "running" && (
    (knownPids.length === 0 || !anyPidAlive) &&
    (!record.browser?.url || !health.ok)
    || (
      !recentActivity &&
      (!record.browser?.url || !health.ok) &&
      (knownTaskPids.length === 0 || !anyTaskPidAlive)
    )
  )
  const stale = record.state === "stale" || staleCandidate

  return {
    runId: record.runId,
    state: record.state,
    stale,
    reasons,
    activePhase: runningPhase,
    process: processes,
    knownPids,
    anyPidAlive,
    knownTaskPids,
    anyTaskPidAlive,
    newestLogAgeMs: Number.isFinite(newestLogAgeMs) ? newestLogAgeMs : undefined,
    staleNoActivityMs: STALE_NO_ACTIVITY_MS,
    devServer: {
      ...record.devServer,
      health,
    },
    browser: record.browser,
    context: context ? {
      id: context.id,
      state: context.state,
      lease: context.lease,
      leaseMatchesRun: contextLeaseMatchesRun,
      checkout: context.checkout,
    } : undefined,
    logs,
    runFile: record.runFile,
  }
}

type RunDiagnosis = Awaited<ReturnType<typeof diagnoseRun>>

const effectiveRunState = (record: TaskRunRecord, diagnosis?: RunDiagnosis) =>
  diagnosis?.stale ? "stale" : record.state

const compactDiagnosis = (diagnosis?: RunDiagnosis) => diagnosis ? {
  stale: diagnosis.stale,
  reasons: diagnosis.reasons,
  activePhase: diagnosis.activePhase?.name,
  anyPidAlive: diagnosis.anyPidAlive,
  anyTaskPidAlive: diagnosis.anyTaskPidAlive,
  knownPids: diagnosis.knownPids,
  knownTaskPids: diagnosis.knownTaskPids,
  newestLogAgeMs: diagnosis.newestLogAgeMs,
  devUrl: diagnosis.devServer.health.url,
  devUrlHealthy: diagnosis.devServer.health.ok,
  devUrlError: diagnosis.devServer.health.error,
  contextState: diagnosis.context?.state,
  contextLeaseMatchesRun: diagnosis.context?.leaseMatchesRun,
} : undefined

const runListView = (record: TaskRunRecord, diagnosis?: RunDiagnosis) => {
  const state = effectiveRunState(record, diagnosis)
  const compact = compactDiagnosis(diagnosis)
  return {
    runId: record.runId,
    state,
    storedState: state !== record.state ? record.state : undefined,
    stale: Boolean(diagnosis?.stale || record.state === "stale"),
    staleReasons: compact?.reasons,
    activePhase: compact?.activePhase,
    liveSignals: compact ? {
      anyPidAlive: compact.anyPidAlive,
      anyTaskPidAlive: compact.anyTaskPidAlive,
      devUrlHealthy: compact.devUrlHealthy,
      newestLogAgeMs: compact.newestLogAgeMs,
    } : undefined,
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
  }
}

const runShowView = (record: TaskRunRecord, diagnosis: RunDiagnosis) => {
  const state = effectiveRunState(record, diagnosis)
  return {
    ...record,
    state,
    storedState: state !== record.state ? record.state : undefined,
    stale: diagnosis.stale,
    diagnosis,
  }
}

const printDiagnosis = (diagnosis: Awaited<ReturnType<typeof diagnoseRun>>) => {
  console.log(`run: ${diagnosis.runId}`)
  console.log(`state: ${diagnosis.state}`)
  console.log(`stale: ${diagnosis.stale ? "yes" : "no"}`)
  console.log(`active phase: ${diagnosis.activePhase?.name ?? "(none)"}`)
  console.log(`any pid alive: ${diagnosis.anyPidAlive ? "yes" : "no"}`)
  console.log(`any task pid alive: ${diagnosis.anyTaskPidAlive ? "yes" : "no"}`)
  console.log(`dev url: ${diagnosis.devServer.health.url ?? "(none)"}`)
  console.log(`dev health: ${diagnosis.devServer.health.ok ? "ok" : "down"}${diagnosis.devServer.health.error ? ` (${diagnosis.devServer.health.error})` : ""}`)
  console.log(`context: ${diagnosis.context ? `${diagnosis.context.id} ${diagnosis.context.state}` : "(none)"}`)
  for (const reason of diagnosis.reasons) {
    console.log(`reason: ${reason}`)
  }
}

const markRunTerminal = async (
  record: TaskRunRecord,
  state: "interrupted" | "stale",
  error: string,
) => {
  const finishedAt = nowIso()
  record.state = state
  record.finishedAt = record.finishedAt ?? finishedAt
  record.durationMs = record.durationMs ?? Math.max(0, Date.now() - Date.parse(record.startedAt))
  record.error = error
  for (const phase of record.phases) {
    if (phase.state !== "running") continue
    phase.state = state
    phase.finishedAt = finishedAt
    if (phase.startedAt) {
      phase.durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(phase.startedAt))
    }
    phase.error = error
  }
  if (record.devServer && !record.devServer.stoppedAt) {
    record.devServer.stoppedAt = finishedAt
  }
  await writeRunRecord(record)
}

const clearAgentStateForRun = async (app: Awaited<ReturnType<typeof loadApp>>, record: TaskRunRecord, state: "interrupted" | "stale") => {
  const agent = await prepareAgent(app, record.baseAgentId || record.agentId, {runtimeId: record.agentId})
  if (!existsSync(agent.paths.stateFile)) return
  const runtime = await readJsonFile<AgentRuntimeState>(agent.paths.stateFile)
  if (runtime.runId && runtime.runId !== record.runId) return
  await writeFile(agent.paths.stateFile, `${JSON.stringify({
    ...runtime,
    running: false,
    finishedAt: runtime.finishedAt ?? nowIso(),
    durationMs: runtime.durationMs ?? Math.max(0, Date.now() - Date.parse(runtime.startedAt ?? record.startedAt)),
    url: "",
    baseAgentId: record.baseAgentId,
    runtimeId: record.agentId,
    state,
  }, null, 2)}\n`)
}

const stopRunRecord = async (
  app: Awaited<ReturnType<typeof loadApp>>,
  id: string,
  state: "interrupted" | "stale" = "interrupted",
) => {
  const record = await readRunRecord(app, id)
  const killed: Array<{pid: number; signal: string; ok: boolean}> = []
  for (const pid of runPids(record)) {
    if (!pidAlive(pid)) continue
    try {
      process.kill(pid, "SIGTERM")
      killed.push({pid, signal: "SIGTERM", ok: true})
    } catch {
      killed.push({pid, signal: "SIGTERM", ok: false})
    }
  }

  const releasedContext = record.context?.id
    ? await releaseRepoContext(app, record.context.id, {workerId: record.agentId, jobId: record.taskId})
    : false
  await markRunTerminal(record, state, state === "stale" ? "run marked stale by reconciliation" : "run stopped by operator")
  await clearAgentStateForRun(app, record, state)
  return {runId: record.runId, state, killed, releasedContext: releasedContext ? record.context?.id : undefined}
}

const runsDiagnose = async (app: Awaited<ReturnType<typeof loadApp>>, id: string, args: string[]) => {
  const record = await readRunRecord(app, id)
  const diagnosis = await diagnoseRun(app, record)
  if (flag(args, "--json")) {
    console.log(JSON.stringify(diagnosis, null, 2))
  } else {
    printDiagnosis(diagnosis)
  }
}

const runsCleanupStale = async (app: Awaited<ReturnType<typeof loadApp>>, args: string[]) => {
  const dir = runRecordsDir(app)
  if (!existsSync(dir)) {
    console.log("[]")
    return
  }

  const dryRun = flag(args, "--dry-run")
  const cleaned = []
  for (const entry of await readdir(dir)) {
    if (!entry.endsWith(".json")) continue
    const record = await readJsonFile<TaskRunRecord>(path.join(dir, entry)).catch(() => undefined)
    if (!record || record.state !== "running") continue
    const diagnosis = await diagnoseRun(app, record)
    if (!diagnosis.stale) continue
    if (dryRun) {
      cleaned.push({runId: record.runId, dryRun: true, reasons: diagnosis.reasons})
      continue
    }
    cleaned.push({...await stopRunRecord(app, record.runId, "stale"), reasons: diagnosis.reasons})
  }
  console.log(JSON.stringify(cleaned, null, 2))
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
  const runRecord = state.runId
    ? await readRunRecord(app, state.runId).catch(() => undefined)
    : undefined
  const diagnosis = runRecord
    ? await diagnoseRun(app, runRecord).catch(() => undefined)
    : undefined
  const devHealth = diagnosis?.devServer.health ?? await checkUrl(url)
  const stale = Boolean(diagnosis?.stale)
  const storedRunning = Boolean(state.running)
  const effectiveRunning = Boolean(storedRunning && !stale)
  const liveWebRun = Boolean(effectiveRunning && state.mode === "web" && url && devHealth.ok)
  return {
    agentId: agent.id,
    baseAgentId: agent.configId,
    runtimeId: agent.id,
    workerName: resolved.workerName,
    role: agent.agent.role,
    running: effectiveRunning,
    storedRunning,
    stale,
    staleReasons: diagnosis?.reasons,
    runDiagnosis: compactDiagnosis(diagnosis),
    liveWebRun,
    devServer: {
      url,
      health: devHealth,
    },
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
  console.log(`running: ${info.running ? "yes" : "no"}${info.storedRunning && !info.running ? " (stored running, diagnosed stale)" : ""}`)
  console.log(`stale: ${info.stale ? "yes" : "no"}`)
  for (const reason of info.staleReasons ?? []) {
    console.log(`stale reason: ${reason}`)
  }
  console.log(`live web run: ${info.liveWebRun ? "yes" : "no"}`)
  console.log(`dev health: ${info.devServer.health.ok ? "ok" : "down"}${info.devServer.health.error ? ` (${info.devServer.health.error})` : ""}`)
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

const statusReport = async (app: Awaited<ReturnType<typeof loadApp>>) => {
  const [workers, recentRuns] = await Promise.all([
    listWorkers(app),
    summarizeRuns(app, await recentRunRecords(app, 10)),
  ])
  const staleRuns = recentRuns.filter(run => run.stale)
  return {
    workers,
    recentRuns,
    staleRuns,
    summary: {
      managedWorkers: workers.length,
      liveManagedWorkers: workers.filter(worker => worker.running).length,
      recentRuns: recentRuns.length,
      staleRuns: staleRuns.length,
      runningRuns: recentRuns.filter(run => run.state === "running").length,
    },
  }
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
    "Never directly do repository implementation work yourself. Always delegate research, planning, implementation, triage, and QA to worker agents.",
    "Preferred operator request verbs: status, stop <worker>, start <role> on <target>, watch <target> as <role>, research <target> and <question>, plan <target> and <goal>, work on <target> [as <role>] [in <mode> mode] [with model <model>] and do <task>.",
    "For same-repo concurrent work, use the explicit form: work on <target> ... in parallel and do <task>.",
    "When a request is clear, dispatch it using the local CLI instead of inventing an ad hoc control path.",
    "If an operator asks you to finish or fix something, treat that as a request to choose and launch the right worker rather than doing the implementation yourself.",
    "For observability, use `openteam runs list`, `openteam runs show <run-id>`, and `openteam browser attach <agent|role|worker-name>` instead of ad hoc log hunting. These commands report effective stale state from live signals; `storedState` is only the raw run-file flag.",
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
  assertControlAllowed(cmd)

  if (cmd === "doctor") {
    await doctor()
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
    await runsShow(app, must(args[2] ?? "", "run-id"), args)
    return
  }

  if (cmd === "runs" && sub === "diagnose") {
    await runsDiagnose(app, must(args[2] ?? "", "run-id"), args)
    return
  }

  if (cmd === "runs" && sub === "stop") {
    console.log(JSON.stringify(await stopRunRecord(app, must(args[2] ?? "", "run-id")), null, 2))
    return
  }

  if (cmd === "runs" && (sub === "cleanup-stale" || sub === "reconcile")) {
    await runsCleanupStale(app, args)
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
