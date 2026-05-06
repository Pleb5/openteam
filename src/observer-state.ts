import {existsSync} from "node:fs"
import {mkdir, readFile, writeFile} from "node:fs/promises"
import path from "node:path"
import type {AppCfg} from "./types.js"

export type ObserverState = {
  version: 1
  stateFile: string
  pid: number
  startedAt: string
  lastHeartbeatAt: string
  lastObservationAt?: string
  lastStatusRefreshAt?: string
  lastError?: string
  stoppedAt?: string
}

export type ObserverHealth = {
  active: boolean
  stateFile: string
  pid?: number
  startedAt?: string
  lastHeartbeatAt?: string
  heartbeatAgeMs?: number
  lastObservationAt?: string
  lastStatusRefreshAt?: string
  lastError?: string
}

const now = () => new Date().toISOString()

export const observerStatePath = (app: AppCfg) =>
  path.join(app.config.runtimeRoot, "orchestrator", "observer-state.json")

export const readObserverState = async (app: AppCfg): Promise<ObserverState | undefined> => {
  const file = observerStatePath(app)
  if (!existsSync(file)) return undefined
  return JSON.parse(await readFile(file, "utf8")) as ObserverState
}

export const writeObserverState = async (app: AppCfg, patch: Partial<ObserverState> = {}) => {
  const file = observerStatePath(app)
  const previous = await readObserverState(app).catch(() => undefined)
  const state: ObserverState = {
    version: 1,
    stateFile: file,
    pid: process.pid,
    startedAt: previous?.startedAt ?? now(),
    lastHeartbeatAt: now(),
    lastObservationAt: previous?.lastObservationAt,
    lastStatusRefreshAt: previous?.lastStatusRefreshAt,
    lastError: previous?.lastError,
    ...patch,
  }
  await mkdir(path.dirname(file), {recursive: true})
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`)
  return state
}

const pidAlive = (pid?: number) => {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const observerHealth = async (app: AppCfg, staleAfterMs = 15_000): Promise<ObserverHealth> => {
  const file = observerStatePath(app)
  const state = await readObserverState(app).catch(() => undefined)
  if (!state) return {active: false, stateFile: file}
  const last = Date.parse(state.lastHeartbeatAt)
  const heartbeatAgeMs = Number.isFinite(last) ? Math.max(0, Date.now() - last) : undefined
  const active = Boolean(!state.stoppedAt && pidAlive(state.pid) && heartbeatAgeMs !== undefined && heartbeatAgeMs <= staleAfterMs)
  return {
    active,
    stateFile: file,
    pid: state.pid,
    startedAt: state.startedAt,
    lastHeartbeatAt: state.lastHeartbeatAt,
    heartbeatAgeMs,
    lastObservationAt: state.lastObservationAt,
    lastStatusRefreshAt: state.lastStatusRefreshAt,
    lastError: state.lastError,
  }
}
