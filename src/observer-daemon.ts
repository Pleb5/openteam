import {buildDueObservationDigest, applyObservationReportPolicy, readDmReportState, writeDmReportState} from "./reporting-policy.js"
import {formatObservationEvent, observeRuns} from "./run-observer.js"
import {appendObserverAlert} from "./observer-notifications.js"
import {writeObserverState} from "./observer-state.js"
import {refreshRuntimeStatus} from "./runtime-status.js"
import type {AppCfg} from "./types.js"

type ObserverDaemonOptions = {
  intervalMs?: number
  limit?: number
  onReport?: (body: string) => Promise<void>
  onError?: (error: unknown) => void
  refreshStatusEvery?: number
}

export type ObserverDaemonHandle = {
  stop: () => void
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export const startObserverDaemon = (app: AppCfg, options: ObserverDaemonOptions = {}): ObserverDaemonHandle => {
  let stopped = false
  const intervalMs = options.intervalMs ?? 5000
  const limit = options.limit ?? 200
  const refreshStatusEvery = Math.max(1, options.refreshStatusEvery ?? 3)
  let loopCount = 0

  const loop = async () => {
    await writeObserverState(app)
    while (!stopped) {
      try {
        loopCount += 1
        const observed = await observeRuns(app, {limit, filter: "active", emitInitial: false})
        const reportState = await readDmReportState(app)
        let reportStateChanged = false
        for (const event of observed.events) {
          const body = formatObservationEvent(event)
          process.stderr.write(`${body}\n`)
          await appendObserverAlert(app, event)
          const decision = applyObservationReportPolicy(reportState, event, app.config.reporting)
          reportStateChanged = true
          if (decision.report) await options.onReport?.(decision.report)
        }
        const digest = buildDueObservationDigest(reportState, app.config.reporting)
        if (digest) {
          reportStateChanged = true
          await options.onReport?.(digest)
        }
        if (reportStateChanged) await writeDmReportState(reportState)
        if (loopCount % refreshStatusEvery === 0) {
          await refreshRuntimeStatus(app).catch(() => undefined)
          await writeObserverState(app, {lastObservationAt: new Date().toISOString(), lastStatusRefreshAt: new Date().toISOString(), lastError: undefined})
        } else {
          await writeObserverState(app, {lastObservationAt: new Date().toISOString(), lastError: undefined})
        }
      } catch (error) {
        await writeObserverState(app, {lastError: errorText(error)}).catch(() => undefined)
        options.onError?.(error)
      }
      await sleep(intervalMs)
    }
    await writeObserverState(app, {stoppedAt: new Date().toISOString()}).catch(() => undefined)
  }

  void loop().catch(error => options.onError?.(error))
  return {
    stop: () => {
      stopped = true
    },
  }
}

export const runObserverDaemon = async (app: AppCfg, options: ObserverDaemonOptions = {}) => {
  let stopped = false
  const handle = startObserverDaemon(app, options)
  const stop = () => {
    stopped = true
    handle.stop()
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  while (!stopped) await sleep(1000)
}
