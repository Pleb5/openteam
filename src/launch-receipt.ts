import {recentRunRecords, diagnoseRun} from "./commands/runs.js"
import {observerHealth} from "./observer-state.js"
import type {ManagedWorker} from "./supervisor.js"
import type {AppCfg, TaskRunRecord} from "./types.js"

export type DetachedLaunchReceiptState = "started" | "failed" | "stale" | "process-exited" | "no-run-file" | "unknown"

export type DetachedLaunchReceipt = {
  state: DetachedLaunchReceiptState
  runId?: string
  runFile?: string
  logFile: string
  pid: number
  activePhase?: string
  failureCategory?: string
  reasons: string[]
  recommendedAction?: string
  observerActive: boolean
  observerHeartbeatAgeMs?: number
}

type ReceiptOptions = {
  timeoutMs?: number
  intervalMs?: number
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const matchesEntry = (entry: ManagedWorker, record: TaskRunRecord) =>
  record.agentId === entry.runtimeId ||
  record.agentId === entry.agentId ||
  record.baseAgentId === entry.agentId ||
  Boolean(entry.task && record.task === entry.task)

const latestMatchingRun = async (app: AppCfg, entry: ManagedWorker) => {
  const records = await recentRunRecords(app, 100)
  return records.map(item => item.record).find(record => matchesEntry(entry, record))
}

const receiptFromRecord = async (app: AppCfg, entry: ManagedWorker, record: TaskRunRecord): Promise<DetachedLaunchReceipt> => {
  const [diagnosis, observer] = await Promise.all([
    diagnoseRun(app, record).catch(() => undefined),
    observerHealth(app).catch(() => ({active: false, stateFile: "", heartbeatAgeMs: undefined})),
  ])
  const effectiveState = diagnosis?.stale
    ? "stale"
    : record.state === "failed" || record.workerState === "failed" || record.verificationState === "failed"
      ? "failed"
      : record.state === "stale"
        ? "stale"
        : record.phases.length > 0
          ? "started"
          : "unknown"
  return {
    state: effectiveState,
    runId: record.runId,
    runFile: record.runFile,
    logFile: entry.logFile,
    pid: entry.pid,
    activePhase: diagnosis?.activePhase?.name ?? [...record.phases].reverse().find(phase => phase.state === "running")?.name,
    failureCategory: record.failureCategory ?? diagnosis?.hardFailure?.category ?? diagnosis?.staleFailureCategory,
    reasons: diagnosis?.reasons ?? [],
    recommendedAction: diagnosis?.recommendedAction ?? record.result?.recommendedAction,
    observerActive: observer.active,
    observerHeartbeatAgeMs: observer.heartbeatAgeMs,
  }
}

export const waitForDetachedLaunchReceipt = async (
  app: AppCfg,
  entry: ManagedWorker,
  options: ReceiptOptions = {},
): Promise<DetachedLaunchReceipt> => {
  const timeoutMs = Math.max(0, options.timeoutMs ?? 15_000)
  const intervalMs = Math.max(100, options.intervalMs ?? 500)
  const deadline = Date.now() + timeoutMs
  let lastRecord: TaskRunRecord | undefined

  while (Date.now() <= deadline) {
    const record = await latestMatchingRun(app, entry)
    if (record) {
      lastRecord = record
      const receipt = await receiptFromRecord(app, entry, record)
      if (receipt.state === "failed" || receipt.state === "stale" || receipt.activePhase || record.phases.length > 0) return receipt
    }
    if (!pidAlive(entry.pid)) break
    await sleep(intervalMs)
  }

  const observer = await observerHealth(app).catch(() => ({active: false, stateFile: "", heartbeatAgeMs: undefined}))
  if (lastRecord) return receiptFromRecord(app, entry, lastRecord)
  return {
    state: pidAlive(entry.pid) ? "no-run-file" : "process-exited",
    logFile: entry.logFile,
    pid: entry.pid,
    reasons: [pidAlive(entry.pid) ? "detached child launched but no run file appeared before receipt timeout" : "detached child exited before a run file appeared"],
    recommendedAction: "openteam status",
    observerActive: observer.active,
    observerHeartbeatAgeMs: observer.heartbeatAgeMs,
  }
}
