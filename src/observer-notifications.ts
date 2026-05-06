import {existsSync} from "node:fs"
import {appendFile, mkdir, readFile, writeFile} from "node:fs/promises"
import path from "node:path"
import {formatObservationEvent, type RunObservationEvent} from "./run-observer.js"
import type {AppCfg} from "./types.js"

type SentEvent = {
  key: string
  firstSentAt: string
  lastSentAt: string
  count: number
  severity: string
}

type NotificationState = {
  version: 1
  stateFile: string
  generatedAt: string
  sent: Record<string, SentEvent>
}

export type ObserverAlert = {
  version: 1
  observedAt: string
  severity: "warning" | "critical"
  runId: string
  field: string
  to?: unknown
  state: string
  role: string
  target?: string
  message: string
  recommendedAction?: string
}

const now = () => new Date().toISOString()

const notificationStatePath = (app: AppCfg) =>
  path.join(app.config.runtimeRoot, "orchestrator", "observer-notifications.json")

export const observerAlertsPath = (app: AppCfg) =>
  path.join(app.config.runtimeRoot, "orchestrator", "alerts.jsonl")

const emptyState = (app: AppCfg): NotificationState => ({
  version: 1,
  stateFile: notificationStatePath(app),
  generatedAt: now(),
  sent: {},
})

const readState = async (app: AppCfg) => {
  const file = notificationStatePath(app)
  if (!existsSync(file)) return emptyState(app)
  return JSON.parse(await readFile(file, "utf8")) as NotificationState
}

const writeState = async (state: NotificationState) => {
  state.generatedAt = now()
  await mkdir(path.dirname(state.stateFile), {recursive: true})
  await writeFile(state.stateFile, `${JSON.stringify(state, null, 2)}\n`)
}

const notifyTransition = (event: RunObservationEvent) =>
  event.transitions.find(transition => transition.severity === "critical") ??
  event.transitions.find(transition => transition.severity === "warning")

export const observationEventNeedsNotification = (event: RunObservationEvent) => {
  const transition = notifyTransition(event)
  if (!transition) return false
  if (transition.severity === "critical") return true
  return (
    transition.field === "state" ||
    transition.field === "opencodeStallSeverity" ||
    transition.field === "opencodeRuntimeKind" ||
    transition.field === "devHealthy" ||
    transition.field === "evidenceLevel" ||
    transition.field === "contextLeaseMatchesRun"
  )
}

const eventKey = (event: RunObservationEvent) => {
  const transition = notifyTransition(event)
  return [
    event.runId,
    transition?.field ?? "observed",
    String(transition?.to ?? event.snapshot.state),
    transition?.severity ?? "info",
  ].join(":")
}

export const appendObserverAlert = async (app: AppCfg, event: RunObservationEvent) => {
  if (!observationEventNeedsNotification(event)) return undefined
  const transition = notifyTransition(event)
  if (!transition || transition.severity === "info") return undefined
  const state = await readState(app)
  const key = eventKey(event)
  const previous = state.sent[key]
  if (previous) return undefined

  const alert: ObserverAlert = {
    version: 1,
    observedAt: event.observedAt,
    severity: transition.severity,
    runId: event.runId,
    field: transition.field,
    to: transition.to,
    state: event.snapshot.state,
    role: event.snapshot.role,
    target: event.snapshot.target,
    message: formatObservationEvent(event),
    recommendedAction: event.snapshot.recommendedAction,
  }
  const file = observerAlertsPath(app)
  await mkdir(path.dirname(file), {recursive: true})
  await appendFile(file, `${JSON.stringify(alert)}\n`)
  state.sent[key] = {
    key,
    firstSentAt: now(),
    lastSentAt: now(),
    count: 1,
    severity: transition.severity,
  }
  await writeState(state)
  return alert
}
