import {existsSync} from "node:fs"
import {readFile, readdir, stat, writeFile} from "node:fs/promises"
import path from "node:path"
import {prepareAgent} from "../config.js"
import {evaluateEvidencePolicy, evidenceLevel, groupEvidenceResults, verificationFailuresBlockTask} from "../evidence-policy.js"
import {detectOpenCodeHardFailure, detectWorkerVerificationBlockers} from "../opencode-log.js"
import {loadRepoRegistry, releaseRepoContext} from "../repo.js"
import type {AgentRuntimeState, AppCfg, TaskRunRecord} from "../types.js"

const value = (args: string[], key: string) => {
  const index = args.indexOf(key)
  if (index === -1) return ""
  return args[index + 1] ?? ""
}

const flag = (args: string[], key: string) => args.includes(key)

const runRecordsDir = (app: AppCfg) => path.join(app.config.runtimeRoot, "runs")

export const readJsonFile = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, "utf8")) as T

export const recentRunRecords = async (app: AppCfg, limit: number) => {
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

export const summarizeRuns = async (app: AppCfg, records: Array<{record: TaskRunRecord}>) =>
  Promise.all(records.map(async ({record}) => {
    const diagnosis = record.state === "running" || record.state === "stale" || record.state === "succeeded"
      ? await diagnoseRun(app, record).catch(() => undefined)
      : undefined
    return runListView(record, diagnosis)
  }))

export const runsList = async (app: AppCfg, args: string[]) => {
  const rawLimit = Number.parseInt(value(args, "--limit") || "20", 10)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 20
  const summaries = await summarizeRuns(app, await recentRunRecords(app, limit))
  console.log(JSON.stringify(summaries, null, 2))
}

export const runEvidenceView = (record: TaskRunRecord) => {
  const results = record.verification?.results ?? []
  const failed = results.filter(result => result.state === "failed")
  const blocked = results.filter(result => result.state === "blocked")
  const succeeded = results.filter(result => result.state === "succeeded")
  const skipped = results.filter(result => result.state === "skipped")
  const policy = evaluateEvidencePolicy(record.doneContract, results)
  const groups = groupEvidenceResults(results)
  return {
    runId: record.runId,
    state: record.state,
    workerState: record.workerState,
    verificationState: record.verificationState,
    failureCategory: record.failureCategory,
    doneContract: record.doneContract,
    level: policy.level,
    finalStateForSuccessfulWorker: policy.finalStateForSuccessfulWorker,
    prEligible: policy.prEligible,
    prBlockers: policy.prBlockers,
    recommendedAction: policy.recommendedAction,
    summary: {
      total: results.length,
      succeeded: succeeded.length,
      failed: failed.length,
      blocked: blocked.length,
      skipped: skipped.length,
    },
    requiredEvidence: policy.requiredEvidence,
    missingEvidence: policy.missingEvidence,
    prPolicy: record.doneContract?.prPolicy,
    groups,
    groupSummary: Object.fromEntries(Object.entries(groups).map(([name, items]) => [name, items.length])),
    results,
    artifacts: Array.from(new Set(results.flatMap(result => [
      ...(result.logFile ? [result.logFile] : []),
      ...(result.artifacts ?? []),
      ...(result.screenshots ?? []),
    ]))),
  }
}

export const runsShow = async (app: AppCfg, id: string, args: string[]) => {
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

const runRecordFile = (app: AppCfg, id: string) => {
  const fileName = path.basename(id).replace(/\.json$/, "")
  return path.join(runRecordsDir(app), `${fileName}.json`)
}

export const readRunRecord = async (app: AppCfg, id: string) => {
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

const opencodeHardFailure = async (file?: string) => {
  if (!file || !existsSync(file)) return undefined
  return detectOpenCodeHardFailure(await readFile(file, "utf8"))
}

const workerVerificationBlockers = async (file?: string) => {
  if (!file || !existsSync(file)) return []
  return detectWorkerVerificationBlockers(await readFile(file, "utf8"))
}

export const checkUrl = async (url?: string) => {
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

export const diagnoseRun = async (app: AppCfg, record: TaskRunRecord) => {
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
  const hardFailure = await opencodeHardFailure(record.logs?.opencode)
  const verificationBlockers = await workerVerificationBlockers(record.logs?.opencode)
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

  if (record.state === "succeeded" && hardFailure) {
    reasons.push(`run is marked succeeded but OpenCode log contains hard failure: ${hardFailure.reason}`)
  }

  const verificationFailureBlocksRun = verificationFailuresBlockTask(record.doneContract)
  if (verificationFailureBlocksRun && record.verificationState === "failed" && record.failureCategory) {
    reasons.push(`verification failed: ${record.failureCategory}`)
  }
  for (const result of record.verification?.results ?? []) {
    if (verificationFailureBlocksRun && result.state === "failed") {
      reasons.push(`verification runner failed: ${result.id}${result.error ? `: ${result.error}` : ""}`)
    }
    if (verificationFailureBlocksRun && result.state === "blocked") {
      reasons.push(`verification runner blocked: ${result.id}${result.blocker ? `: ${result.blocker}` : ""}`)
    }
  }

  if (verificationBlockers.length > 0 && record.state !== "running") {
    reasons.push(`worker log contains verification blockers: ${verificationBlockers.map(item => item.reason).join("; ")}`)
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
    provision: {
      state: record.provisionState,
      failureCategory: record.provisionFailureCategory,
      projectProfilePath: record.projectProfilePath ?? record.projectProfile?.path,
      verificationToolingReady: record.verificationToolingReady,
      logFile: record.logs?.provision,
    },
    hardFailure,
    verificationBlockers,
    verification: record.verification,
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
  record.state === "succeeded" && (
    diagnosis?.hardFailure ||
    record.workerState === "failed" ||
    (
      verificationFailuresBlockTask(record.doneContract) &&
      (
        record.verificationState === "failed"
        || record.verification?.results?.some(result => result.state === "failed" || result.state === "blocked")
      )
    )
  )
    ? "failed"
    : diagnosis?.stale ? "stale" : record.state

export const compactDiagnosis = (diagnosis?: RunDiagnosis) => diagnosis ? {
  stale: diagnosis.stale,
  reasons: diagnosis.reasons,
  hardFailure: diagnosis.hardFailure,
  verificationBlockers: diagnosis.verificationBlockers,
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
  verificationRunners: diagnosis.verification?.plan.runners.map(runner => ({
    id: runner.id,
    kind: runner.kind,
    configured: runner.configured,
    reason: runner.reason,
  })),
  verificationResults: diagnosis.verification?.results?.map(result => ({
    id: result.id,
    kind: result.kind,
    state: result.state,
    evidenceType: result.evidenceType,
    source: result.source,
    note: result.note,
    blocker: result.blocker,
    error: result.error,
    logFile: result.logFile,
    artifacts: result.artifacts,
    screenshots: result.screenshots,
    url: result.url,
    flow: result.flow,
  })),
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
    workerState: record.workerState,
    verificationState: record.verificationState,
    failureCategory: record.failureCategory,
    provisionState: record.provisionState,
    provisionFailureCategory: record.provisionFailureCategory,
    projectProfilePath: record.projectProfilePath,
    verificationToolingReady: record.verificationToolingReady,
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
    subject: record.subject ? {
      kind: record.subject.kind,
      eventId: record.subject.encodedEvent ?? record.subject.eventId,
      repo: record.subject.repo?.key ?? record.subject.repoTarget,
      path: record.subject.path,
      tipCommit: record.subject.tipCommit,
    } : undefined,
    mode: record.mode,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    durationMs: record.durationMs,
    contextId: record.context?.id,
    devEnv: record.devEnv?.kind,
    devEnvSource: record.devEnv?.source,
    projectStacks: record.projectProfile?.stacks,
    projectProfile: record.projectProfile?.path,
    verificationPlan: record.verification?.planPath,
    verificationRunners: record.verification?.plan.runners.map(runner => `${runner.id}:${runner.configured ? "configured" : "unavailable"}`),
    verificationResults: record.verification?.results?.map(result => `${result.id}:${result.state}`),
    evidenceLevel: evidenceLevel(record.doneContract, record.verification?.results ?? []),
    doneContract: record.doneContract?.taskClass,
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
    evidence: runEvidenceView(record),
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
  if (diagnosis.provision.state) console.log(`provision: ${diagnosis.provision.state}${diagnosis.provision.failureCategory ? ` (${diagnosis.provision.failureCategory})` : ""}`)
  if (diagnosis.provision.projectProfilePath) console.log(`project profile: ${diagnosis.provision.projectProfilePath}`)
  if (diagnosis.provision.verificationToolingReady !== undefined) console.log(`verification tooling ready: ${diagnosis.provision.verificationToolingReady ? "yes" : "no"}`)
  if (diagnosis.verification?.planPath) console.log(`verification plan: ${diagnosis.verification.planPath}`)
  for (const runner of diagnosis.verification?.plan.runners ?? []) {
    console.log(`verification runner: ${runner.id} (${runner.kind}) ${runner.configured ? "configured" : `unavailable: ${runner.reason ?? "unknown"}`}`)
  }
  for (const result of diagnosis.verification?.results ?? []) {
    const details = result.blocker ?? result.error ?? result.skippedReason ?? result.logFile ?? ""
    console.log(`verification result: ${result.id} ${result.state}${details ? ` (${details})` : ""}`)
  }
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

const clearAgentStateForRun = async (app: AppCfg, record: TaskRunRecord, state: "interrupted" | "stale") => {
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

export const stopRunRecord = async (
  app: AppCfg,
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

export const runsDiagnose = async (app: AppCfg, id: string, args: string[]) => {
  const record = await readRunRecord(app, id)
  const diagnosis = await diagnoseRun(app, record)
  if (flag(args, "--json")) {
    console.log(JSON.stringify(diagnosis, null, 2))
  } else {
    printDiagnosis(diagnosis)
  }
}

export const runsEvidence = async (app: AppCfg, id: string, args: string[]) => {
  const record = await readRunRecord(app, id)
  const view = runEvidenceView(record)
  if (flag(args, "--json")) {
    console.log(JSON.stringify(view, null, 2))
    return
  }
  console.log(`run: ${view.runId}`)
  console.log(`evidence: ${view.level}`)
  console.log(`final state if worker succeeded: ${view.finalStateForSuccessfulWorker}`)
  console.log(`PR eligible: ${view.prEligible ? "yes" : "no"}`)
  console.log(`results: total=${view.summary.total} succeeded=${view.summary.succeeded} failed=${view.summary.failed} blocked=${view.summary.blocked} skipped=${view.summary.skipped}`)
  if (view.doneContract) {
    console.log(`done contract: ${view.doneContract.taskClass}`)
    for (const item of view.doneContract.requiredEvidence) console.log(`required: ${item}`)
    console.log(`pr policy: ${view.doneContract.prPolicy}`)
  }
  for (const item of view.missingEvidence) console.log(`missing: ${item}`)
  for (const blocker of view.prBlockers) console.log(`PR blocker: ${blocker}`)
  console.log(`recommended: ${view.recommendedAction}`)
  for (const [group, count] of Object.entries(view.groupSummary)) {
    if (count > 0) console.log(`group: ${group} ${count}`)
  }
  for (const result of view.results) {
    const detail = result.note ?? result.flow ?? result.url ?? result.blocker ?? result.error ?? result.skippedReason ?? result.logFile ?? ""
    console.log(`result: ${result.id} ${result.state}${detail ? ` (${detail})` : ""}`)
  }
  for (const artifact of view.artifacts) console.log(`artifact: ${artifact}`)
}

export const runsCleanupStale = async (app: AppCfg, args: string[]) => {
  const dir = runRecordsDir(app)
  if (!existsSync(dir)) {
    console.log("[]")
    return []
  }

  const dryRun = flag(args, "--dry-run")
  const cleaned = []
  for (const entry of await readdir(dir)) {
    if (!entry.endsWith(".json")) continue
    const record = await readJsonFile<TaskRunRecord>(path.join(dir, entry)).catch(() => undefined)
    if (!record || (record.state !== "running" && record.state !== "stale")) continue
    const diagnosis = await diagnoseRun(app, record)
    if (!diagnosis.stale) continue
    if (dryRun) {
      cleaned.push({runId: record.runId, dryRun: true, reasons: diagnosis.reasons})
      continue
    }
    cleaned.push({...await stopRunRecord(app, record.runId, "stale"), reasons: diagnosis.reasons})
  }
  console.log(JSON.stringify(cleaned, null, 2))
  return cleaned
}

export const cleanupStaleRunsForContext = async (app: AppCfg, contextId: string) => {
  const dir = runRecordsDir(app)
  if (!existsSync(dir)) return []

  const cleaned = []
  for (const entry of await readdir(dir)) {
    if (!entry.endsWith(".json")) continue
    const record = await readJsonFile<TaskRunRecord>(path.join(dir, entry)).catch(() => undefined)
    if (!record || (record.state !== "running" && record.state !== "stale") || record.context?.id !== contextId) continue
    const diagnosis = await diagnoseRun(app, record)
    if (!diagnosis.stale) continue
    cleaned.push({...await stopRunRecord(app, record.runId, "stale"), reasons: diagnosis.reasons})
  }
  return cleaned
}
