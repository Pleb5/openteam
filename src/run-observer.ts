import {existsSync} from "node:fs"
import {mkdir, readFile, writeFile} from "node:fs/promises"
import path from "node:path"
import {diagnoseRun, readRunRecord, recentRunRecords, runEvidenceView} from "./commands/runs.js"
import {verificationFailuresBlockTask} from "./evidence-policy.js"
import {resolveRunFamilyKey} from "./reporting-policy.js"
import type {AppCfg, TaskRunRecord} from "./types.js"

type ObservationSeverity = "info" | "warning" | "critical"

export type RunObservationSnapshot = {
  runId: string
  observedAt: string
  state: string
  storedState: string
  agentId: string
  baseAgentId: string
  role: string
  familyKey?: string
  target?: string
  mode?: string
  taskId: string
  task?: string
  workerState?: string
  verificationState?: string
  failureCategory?: string
  activePhase?: string
  activePhaseDurationMs?: number
  stale: boolean
  staleReasons: string[]
  anyPidAlive: boolean
  anyTaskPidAlive: boolean
  newestLogAgeMs?: number
  opencodeLogAgeMs?: number
  opencodeLogSize?: number
  opencodeLastLine?: string
  opencodeBlockedKind?: string
  opencodeBlockedReason?: string
  opencodeStallSeverity?: "warning" | "critical"
  opencodeWatchdogSeverity?: string
  opencodeInFlightTools?: string[]
  opencodeRuntimeKind?: string
  opencodeRuntimeEvidence?: string
  opencodeLastCompletedTool?: string
  opencodeCurrentTurnAgeMs?: number
  devUrl?: string
  devStatus?: string
  devHealthy: boolean
  devError?: string
  evidenceLevel: string
  prEligible: boolean
  missingEvidenceCount: number
  verificationResultCount: number
  contextId?: string
  contextState?: string
  contextLeaseMatchesRun?: boolean
  finishedAt?: string
  durationMs?: number
  recommendedAction?: string
}

export type RunObservationTransition = {
  field: string
  from?: unknown
  to?: unknown
  severity: ObservationSeverity
  message: string
}

export type RunObservationEvent = {
  runId: string
  observedAt: string
  transitions: RunObservationTransition[]
  snapshot: RunObservationSnapshot
}

export type RunObservationState = {
  version: 1
  generatedAt: string
  stateFile: string
  runs: Record<string, RunObservationSnapshot>
  events: RunObservationEvent[]
}

type ObserveOptions = {
  limit?: number
  emitInitial?: boolean
  filter?: "all" | "active" | "needs-review"
}

const observationStateFile = (app: AppCfg) =>
  path.join(app.config.runtimeRoot, "orchestrator", "observations.json")

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const readObservationState = async (app: AppCfg): Promise<RunObservationState> => {
  const file = observationStateFile(app)
  if (!existsSync(file)) {
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      stateFile: file,
      runs: {},
      events: [],
    }
  }
  return JSON.parse(await readFile(file, "utf8")) as RunObservationState
}

const writeObservationState = async (state: RunObservationState) => {
  await mkdir(path.dirname(state.stateFile), {recursive: true})
  await writeFile(state.stateFile, `${JSON.stringify(state, null, 2)}\n`)
}

const effectiveState = (record: TaskRunRecord, diagnosis: Awaited<ReturnType<typeof diagnoseRun>>) => {
  if (diagnosis.stale) return "stale"
  if (
    (record.state === "succeeded" || record.state === "needs-review") && (
      diagnosis.hardFailure ||
      record.workerState === "failed" ||
      (
        verificationFailuresBlockTask(record.doneContract) &&
        (
          record.verificationState === "failed" ||
          record.verification?.results?.some(result => result.state === "failed" || result.state === "blocked")
        )
      )
    )
  ) return "failed"
  return record.state
}

export const snapshotRunObservation = async (
  app: AppCfg,
  record: TaskRunRecord,
): Promise<RunObservationSnapshot> => {
  const diagnosis = await diagnoseRun(app, record)
  const evidence = runEvidenceView(record)
  const devHealth = diagnosis.devServer.health
  const familyKey = await resolveRunFamilyKey(record)
  return {
    runId: record.runId,
    observedAt: new Date().toISOString(),
    state: effectiveState(record, diagnosis),
    storedState: record.state,
    agentId: record.agentId,
    baseAgentId: record.baseAgentId,
    role: record.role,
    familyKey,
    target: record.target,
    mode: record.mode,
    taskId: record.taskId,
    task: record.task,
    workerState: record.workerState,
    verificationState: record.verificationState,
    failureCategory: record.failureCategory ?? diagnosis.hardFailure?.category,
    activePhase: diagnosis.activePhase?.name,
    activePhaseDurationMs: diagnosis.activePhaseDurationMs,
    stale: diagnosis.stale,
    staleReasons: diagnosis.reasons,
    anyPidAlive: diagnosis.anyPidAlive,
    anyTaskPidAlive: diagnosis.anyTaskPidAlive,
    newestLogAgeMs: diagnosis.newestLogAgeMs,
    opencodeLogAgeMs: diagnosis.opencodeProgress.logAgeMs,
    opencodeLogSize: diagnosis.opencodeProgress.logSize,
    opencodeLastLine: diagnosis.opencodeProgress.lastLine,
    opencodeBlockedKind: diagnosis.opencodeProgress.blocked?.kind,
    opencodeBlockedReason: diagnosis.opencodeProgress.blocked?.reason,
    opencodeStallSeverity: diagnosis.opencodeProgress.stallSeverity,
    opencodeWatchdogSeverity: record.opencodeWatchdog?.severity,
    opencodeInFlightTools: record.opencodeWatchdog?.inFlightTools,
    opencodeRuntimeKind: diagnosis.opencodeProgress.runtime?.kind ?? record.opencodeWatchdog?.runtimeKind,
    opencodeRuntimeEvidence: diagnosis.opencodeProgress.runtime?.evidence ?? record.opencodeWatchdog?.runtimeEvidence,
    opencodeLastCompletedTool: record.opencodeWatchdog?.lastCompletedTool ?? (diagnosis.opencodeProgress.runtime?.lastCompletedTool ? `${diagnosis.opencodeProgress.runtime.lastCompletedTool.name}${diagnosis.opencodeProgress.runtime.lastCompletedTool.inputPath ? ` ${diagnosis.opencodeProgress.runtime.lastCompletedTool.inputPath}` : ""}` : undefined),
    opencodeCurrentTurnAgeMs: diagnosis.opencodeProgress.runtime?.messageAgeMs ?? record.opencodeWatchdog?.currentTurnAgeMs,
    devUrl: devHealth.url,
    devStatus: diagnosis.devServer.status,
    devHealthy: devHealth.ok,
    devError: devHealth.error,
    evidenceLevel: evidence.level,
    prEligible: evidence.prEligible,
    missingEvidenceCount: evidence.missingEvidence.length,
    verificationResultCount: evidence.summary.total,
    contextId: diagnosis.context?.id,
    contextState: diagnosis.context?.state,
    contextLeaseMatchesRun: diagnosis.context?.leaseMatchesRun,
    finishedAt: record.finishedAt,
    durationMs: record.durationMs,
    recommendedAction: diagnosis.hardFailure
      ? diagnosis.recommendedAction
      : record.state === "needs-review"
        ? evidence.recommendedAction
        : diagnosis.recommendedAction ?? evidence.recommendedAction,
  }
}

const fieldSeverity = (field: string, to: unknown): ObservationSeverity => {
  if (field === "state" && (to === "failed" || to === "stale")) return "critical"
  if (field === "state" && to === "needs-review") return "warning"
  if (field === "devHealthy" && to === false) return "warning"
  if (field === "opencodeBlockedKind" && to) return "critical"
  if (field === "opencodeStallSeverity" && to === "critical") return "critical"
  if (field === "opencodeStallSeverity" && to === "warning") return "warning"
  if (field === "opencodeRuntimeKind" && (to === "model-stream-stalled" || to === "model-stream-stalled-after-tool")) return "warning"
  if (field === "opencodeWatchdogSeverity" && to === "critical") return "critical"
  if (field === "opencodeWatchdogSeverity" && to === "warning") return "warning"
  if (field === "evidenceLevel" && (to === "failed" || to === "blocked")) return "critical"
  if (field === "evidenceLevel" && (to === "weak" || to === "none")) return "warning"
  if (field === "prEligible" && to === true) return "info"
  if (field === "contextLeaseMatchesRun" && to === false) return "warning"
  return "info"
}

const transitionMessage = (
  runId: string,
  field: string,
  from: unknown,
  to: unknown,
) => `${runId}: ${field} changed from ${String(from ?? "(unset)")} to ${String(to ?? "(unset)")}`

const diffSnapshots = (
  previous: RunObservationSnapshot | undefined,
  next: RunObservationSnapshot,
  emitInitial: boolean,
) => {
  if (!previous) {
    return emitInitial
      ? [{
        field: "observed",
        from: undefined,
        to: next.state,
        severity: next.state === "failed" || next.state === "stale" ? "critical" : next.state === "needs-review" ? "warning" : "info",
        message: `${next.runId}: observed ${next.state}`,
      } satisfies RunObservationTransition]
      : []
  }

  const fields: Array<keyof RunObservationSnapshot> = [
    "state",
    "activePhase",
    "opencodeBlockedKind",
    "opencodeStallSeverity",
    "opencodeRuntimeKind",
    "opencodeWatchdogSeverity",
    "devHealthy",
    "evidenceLevel",
    "prEligible",
    "missingEvidenceCount",
    "verificationResultCount",
    "contextState",
    "contextLeaseMatchesRun",
    "failureCategory",
  ]

  return fields
    .filter(field => JSON.stringify(previous[field]) !== JSON.stringify(next[field]))
    .map(field => ({
      field,
      from: previous[field],
      to: next[field],
      severity: fieldSeverity(field, next[field]),
      message: transitionMessage(next.runId, field, previous[field], next[field]),
    }))
}

const includeSnapshot = (
  snapshot: RunObservationSnapshot,
  previous: RunObservationSnapshot | undefined,
  filter: ObserveOptions["filter"],
) => {
  if (!filter || filter === "all") return true
  if (filter === "active") {
    return snapshot.state === "running" || snapshot.activePhase !== undefined || previous?.state === "running" || previous?.activePhase !== undefined
  }
  if (filter === "needs-review") {
    return (
      snapshot.state === "needs-review" ||
      snapshot.evidenceLevel === "weak" ||
      snapshot.evidenceLevel === "none" ||
      previous?.state === "needs-review" ||
      previous?.evidenceLevel === "weak" ||
      previous?.evidenceLevel === "none"
    )
  }
  return true
}

export const observeRuns = async (
  app: AppCfg,
  options: ObserveOptions = {},
) => {
  const state = await readObservationState(app)
  const records = await recentRunRecords(app, options.limit ?? 100)
  const events: RunObservationEvent[] = []
  const snapshots: RunObservationSnapshot[] = []

  for (const {record} of records) {
    const snapshot = await snapshotRunObservation(app, record)
    const previous = state.runs[snapshot.runId]
    if (!includeSnapshot(snapshot, previous, options.filter)) continue
    const transitions = diffSnapshots(previous, snapshot, Boolean(options.emitInitial))
    state.runs[snapshot.runId] = snapshot
    snapshots.push(snapshot)
    if (transitions.length === 0) continue
    events.push({
      runId: snapshot.runId,
      observedAt: snapshot.observedAt,
      transitions,
      snapshot,
    })
  }

  state.generatedAt = new Date().toISOString()
  state.events = [...state.events, ...events].slice(-500)
  await writeObservationState(state)
  return {state, snapshots, events}
}

export const observeRun = async (app: AppCfg, runId: string) => {
  const record = await readRunRecord(app, runId)
  return snapshotRunObservation(app, record)
}

const printSnapshot = (snapshot: RunObservationSnapshot) => {
  console.log(`run: ${snapshot.runId}`)
  console.log(`state: ${snapshot.state}${snapshot.storedState !== snapshot.state ? ` (stored ${snapshot.storedState})` : ""}`)
  console.log(`role: ${snapshot.role}`)
  console.log(`target: ${snapshot.target ?? "(none)"}`)
  console.log(`phase: ${snapshot.activePhase ?? "(none)"}`)
  if (snapshot.activePhaseDurationMs !== undefined) console.log(`phase duration ms: ${snapshot.activePhaseDurationMs}`)
  console.log(`pids: any=${snapshot.anyPidAlive ? "yes" : "no"} task=${snapshot.anyTaskPidAlive ? "yes" : "no"}`)
  if (snapshot.opencodeLogAgeMs !== undefined) console.log(`opencode log age ms: ${snapshot.opencodeLogAgeMs}`)
  if (snapshot.opencodeStallSeverity) console.log(`opencode stall: ${snapshot.opencodeStallSeverity}`)
  if (snapshot.opencodeRuntimeKind) console.log(`opencode runtime: ${snapshot.opencodeRuntimeKind}${snapshot.opencodeRuntimeEvidence ? ` (${snapshot.opencodeRuntimeEvidence})` : ""}`)
  if (snapshot.opencodeRuntimeKind === "model-stream-stalled-after-tool") console.log(`opencode model stream stalled${snapshot.opencodeCurrentTurnAgeMs !== undefined ? ` for ${Math.round(snapshot.opencodeCurrentTurnAgeMs / 60_000)}m` : ""}${snapshot.opencodeLastCompletedTool ? ` after completed ${snapshot.opencodeLastCompletedTool}` : ""}`)
  if (snapshot.opencodeBlockedKind) console.log(`opencode blocked: ${snapshot.opencodeBlockedKind}${snapshot.opencodeBlockedReason ? ` (${snapshot.opencodeBlockedReason})` : ""}`)
  console.log(`dev: ${snapshot.devUrl ?? "(none)"} ${snapshot.devStatus ?? (snapshot.devHealthy ? "healthy" : "down")}${snapshot.devError && !snapshot.devStatus?.startsWith("stopped after") ? ` (${snapshot.devError})` : ""}`)
  console.log(`evidence: ${snapshot.evidenceLevel}`)
  console.log(`PR eligible: ${snapshot.prEligible ? "yes" : "no"}`)
  console.log(`missing evidence: ${snapshot.missingEvidenceCount}`)
  console.log(`verification results: ${snapshot.verificationResultCount}`)
  console.log(`recommended: ${snapshot.recommendedAction ?? "(none)"}`)
  for (const reason of snapshot.staleReasons) {
    console.log(`reason: ${reason}`)
  }
}

export const formatObservationEvent = (event: RunObservationEvent) => {
  const lines = [`run observation: ${event.runId}`]
  for (const transition of event.transitions) {
    lines.push(`[${transition.severity}] ${transition.message}`)
  }
  lines.push(`state: ${event.snapshot.state}`)
  if (event.snapshot.opencodeBlockedKind) lines.push(`opencode blocked: ${event.snapshot.opencodeBlockedKind}`)
  if (event.snapshot.opencodeStallSeverity) lines.push(`opencode stall: ${event.snapshot.opencodeStallSeverity}`)
  if (event.snapshot.opencodeRuntimeKind === "model-stream-stalled-after-tool") lines.push(`OpenCode model stream stalled${event.snapshot.opencodeCurrentTurnAgeMs !== undefined ? ` for ${Math.round(event.snapshot.opencodeCurrentTurnAgeMs / 60_000)}m` : ""}${event.snapshot.opencodeLastCompletedTool ? ` after completed ${event.snapshot.opencodeLastCompletedTool}` : ""}`)
  else if (event.snapshot.opencodeRuntimeKind === "model-stream-stalled") lines.push(`OpenCode model stream stalled${event.snapshot.opencodeCurrentTurnAgeMs !== undefined ? ` for ${Math.round(event.snapshot.opencodeCurrentTurnAgeMs / 60_000)}m` : ""}`)
  lines.push(`evidence: ${event.snapshot.evidenceLevel}`)
  lines.push(`PR eligible: ${event.snapshot.prEligible ? "yes" : "no"}`)
  if (event.snapshot.recommendedAction) {
    lines.push(`recommended: ${event.snapshot.recommendedAction}`)
  }
  return lines.join("\n")
}

const printEvent = (event: RunObservationEvent) => {
  console.log(formatObservationEvent(event))
}

const parseInterval = (args: string[], fallback: number) => {
  const index = args.indexOf("--interval-ms")
  if (index === -1) return fallback
  const parsed = Number.parseInt(args[index + 1] ?? "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const value = (args: string[], key: string) => {
  const index = args.indexOf(key)
  if (index === -1) return ""
  return args[index + 1] ?? ""
}

const flag = (args: string[], key: string) => args.includes(key)

const filterFromArgs = (args: string[]): ObserveOptions["filter"] => {
  if (flag(args, "--active")) return "active"
  if (flag(args, "--needs-review")) return "needs-review"
  return "all"
}

export const runsObserveCommand = async (app: AppCfg, runId: string, args: string[]) => {
  const snapshot = await observeRun(app, runId)
  if (flag(args, "--json")) {
    console.log(JSON.stringify(snapshot, null, 2))
    return
  }
  printSnapshot(snapshot)
}

export const runsWatchCommand = async (app: AppCfg, args: string[]) => {
  const json = flag(args, "--json")
  const once = flag(args, "--once")
  const intervalMs = parseInterval(args, 2000)
  const rawLimit = Number.parseInt(value(args, "--limit") || "100", 10)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 100
  const filter = filterFromArgs(args)

  for (;;) {
    const observed = await observeRuns(app, {limit, filter, emitInitial: true})
    if (json) {
      console.log(JSON.stringify({events: observed.events, snapshots: observed.snapshots}, null, 2))
    } else {
      for (const event of observed.events) {
        printEvent(event)
      }
      if (once && observed.events.length === 0) {
        console.log("no run observation changes")
      }
    }
    if (once) return
    await sleep(intervalMs)
  }
}
