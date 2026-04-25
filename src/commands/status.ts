import {listWorkers} from "../supervisor.js"
import type {AppCfg} from "../types.js"
import {recentRunRecords, summarizeRuns} from "./runs.js"

export const statusReport = async (app: AppCfg) => {
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
