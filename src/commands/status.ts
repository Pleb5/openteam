import type {AppCfg} from "../types.js"
import {refreshRuntimeStatus} from "../runtime-status.js"
import {recentRunRecords, summarizeRuns} from "./runs.js"
import {listWorkers} from "../supervisor.js"

export const statusReport = async (app: AppCfg) => {
  const [workers, recentRuns, runtimeStatus] = await Promise.all([
    listWorkers(app),
    summarizeRuns(app, await recentRunRecords(app, 10)),
    refreshRuntimeStatus(app),
  ])
  const staleRuns = recentRuns.filter(run => run.stale)
  return {
    workers,
    recentRuns,
    staleRuns,
    leases: runtimeStatus.leases,
    runtimeStatus,
    summary: {
      managedWorkers: workers.length,
      liveManagedWorkers: workers.filter(worker => worker.running).length,
      recentRuns: recentRuns.length,
      staleRuns: staleRuns.length,
      runningRuns: recentRuns.filter(run => run.state === "running").length,
      runStates: runtimeStatus.runs.byState,
      leasedContexts: runtimeStatus.leases.leased,
      staleLeases: runtimeStatus.leases.stale,
      statusFile: runtimeStatus.statusFile,
    },
  }
}
