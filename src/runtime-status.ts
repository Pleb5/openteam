import {existsSync} from "node:fs"
import {mkdir, readFile, writeFile} from "node:fs/promises"
import path from "node:path"
import {loadRepoRegistry} from "./repo.js"
import {isOperatorTakeoverLease} from "./repo.js"
import {listWorkers} from "./supervisor.js"
import type {AppCfg, RepoContext} from "./types.js"
import {recentRunRecords, summarizeRuns} from "./commands/runs.js"
import {observerAlertsPath} from "./observer-notifications.js"
import {observerHealth, type ObserverHealth} from "./observer-state.js"

export type RuntimeStatus = {
  version: 1
  generatedAt: string
  statusFile: string
  orchestratorPid?: number
  workers: {
    managed: number
    live: number
    liveWorkers: Array<{
      name: string
      agentId: string
      runtimeId?: string
      role: string
      pid: number
      target?: string
      mode?: string
    }>
  }
  runs: {
    recent: number
    byState: Record<string, number>
    stale: number
    running: number
  }
  leases: {
    leased: number
    operatorHeld: number
    operatorHeldContexts: Array<{
      id: string
      repoKey: string
      jobId?: string
    }>
    stale: number
    staleContexts: Array<{
      id: string
      repoKey: string
      workerId?: string
      jobId?: string
      reason: string
    }>
  }
  cleanup: {
    lastCleanupAt?: string
    lastCleanupDryRunAt?: string
    lastCleanupCount?: number
  }
  observer: ObserverHealth & {
    alertsFile: string
  }
}

const statusPath = (app: AppCfg) => path.join(app.config.runtimeRoot, "status.json")

const readPreviousStatus = async (app: AppCfg) => {
  const file = statusPath(app)
  if (!existsSync(file)) return undefined
  return JSON.parse(await readFile(file, "utf8")) as RuntimeStatus
}

const countByState = (runs: Array<{state: string}>) =>
  runs.reduce<Record<string, number>>((acc, run) => {
    acc[run.state] = (acc[run.state] ?? 0) + 1
    return acc
  }, {})

const leaseKey = (context: RepoContext) =>
  `${context.lease?.workerId ?? ""}:${context.lease?.jobId ?? ""}`

const staleLeaseSummaries = (
  contexts: RepoContext[],
  runs: Array<{state: string; agentId: string; taskId?: string; contextId?: string}>,
) => {
  const active = new Set(
    runs
      .filter(run => run.state === "running")
      .map(run => `${run.agentId}:${run.taskId ?? ""}:${run.contextId ?? ""}`),
  )

  return contexts
    .filter(context => context.state === "leased")
    .filter(context => !isOperatorTakeoverLease(context.lease))
    .map(context => {
      const expected = `${context.lease?.workerId ?? ""}:${context.lease?.jobId ?? ""}:${context.id}`
      return {context, active: active.has(expected)}
    })
    .filter(item => !item.active)
    .map(({context}) => ({
      id: context.id,
      repoKey: context.repoKey,
      workerId: context.lease?.workerId,
      jobId: context.lease?.jobId,
      reason: context.lease
        ? `no live running run matches lease ${leaseKey(context)}`
        : "context is leased without lease metadata",
    }))
}

export const buildRuntimeStatus = async (
  app: AppCfg,
  cleanup: Partial<RuntimeStatus["cleanup"]> = {},
): Promise<RuntimeStatus> => {
  const workers = await listWorkers(app)
  const [recentRecords, registry, previous, observer] = await Promise.all([
    recentRunRecords(app, 200),
    loadRepoRegistry(app),
    readPreviousStatus(app).catch(() => undefined),
    observerHealth(app).catch(() => ({active: false, stateFile: path.join(app.config.runtimeRoot, "orchestrator", "observer-state.json")})),
  ])
  const recentRuns = await summarizeRuns(app, recentRecords)
  const summariesByRunId = new Map(recentRuns.map(run => [run.runId, run]))
  const liveWorkers = workers.filter(worker => worker.running)
  const contexts = Object.values(registry.contexts)
  const leasedContexts = contexts.filter(context => context.state === "leased")
  const operatorHeldContexts = leasedContexts.filter(context => isOperatorTakeoverLease(context.lease))
  const staleContexts = staleLeaseSummaries(leasedContexts, recentRecords.map(({record}) => {
    const summary = summariesByRunId.get(record.runId)
    return {
      state: summary?.state ?? record.state,
      agentId: record.agentId,
      taskId: record.taskId,
      contextId: record.context?.id,
    }
  }))
  const orchestrator = liveWorkers.find(worker => worker.agentId === "orchestrator-01")

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    statusFile: statusPath(app),
    orchestratorPid: orchestrator?.pid,
    workers: {
      managed: workers.length,
      live: liveWorkers.length,
      liveWorkers: liveWorkers.map(worker => ({
        name: worker.name,
        agentId: worker.agentId,
        runtimeId: worker.runtimeId,
        role: worker.role,
        pid: worker.pid,
        target: worker.target,
        mode: worker.mode,
      })),
    },
    runs: {
      recent: recentRuns.length,
      byState: countByState(recentRuns),
      stale: recentRuns.filter(run => run.stale).length,
      running: recentRuns.filter(run => run.state === "running").length,
    },
    leases: {
      leased: leasedContexts.length,
      operatorHeld: operatorHeldContexts.length,
      operatorHeldContexts: operatorHeldContexts.map(context => ({
        id: context.id,
        repoKey: context.repoKey,
        jobId: context.lease?.jobId,
      })),
      stale: staleContexts.length,
      staleContexts,
    },
    cleanup: {
      lastCleanupAt: cleanup.lastCleanupAt ?? previous?.cleanup.lastCleanupAt,
      lastCleanupDryRunAt: cleanup.lastCleanupDryRunAt ?? previous?.cleanup.lastCleanupDryRunAt,
      lastCleanupCount: cleanup.lastCleanupCount ?? previous?.cleanup.lastCleanupCount,
    },
    observer: {
      ...observer,
      alertsFile: observerAlertsPath(app),
    },
  }
}

export const writeRuntimeStatus = async (app: AppCfg, status: RuntimeStatus) => {
  await mkdir(path.dirname(status.statusFile), {recursive: true})
  await writeFile(status.statusFile, `${JSON.stringify(status, null, 2)}\n`)
  return status.statusFile
}

export const refreshRuntimeStatus = async (
  app: AppCfg,
  cleanup: Partial<RuntimeStatus["cleanup"]> = {},
) => {
  const status = await buildRuntimeStatus(app, cleanup)
  await writeRuntimeStatus(app, status)
  return status
}
