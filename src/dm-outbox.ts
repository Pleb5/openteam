import {createHash} from "node:crypto"
import {existsSync} from "node:fs"
import {mkdir, readFile, writeFile} from "node:fs/promises"
import path from "node:path"
import type {AppCfg} from "./types.js"

export type DmOutboxEventType = "runtime-report" | "task-report" | "observation-report" | "digest" | "dm"

export type DmOutboxAttempt = {
  id: string
  eventType: DmOutboxEventType
  runId?: string
  familyKey?: string
  recipient: string
  bodyFingerprint: string
  state: "sent" | "failed"
  relayResult?: string
  error?: string
  retryCount: number
  attemptedAt: string
  sentAt?: string
}

export type DmOutboxState = {
  version: 1
  generatedAt: string
  stateFile: string
  attempts: DmOutboxAttempt[]
  summary: {
    attempts: number
    sent: number
    failed: number
    publishFailures: number
  }
}

export type ReportOutboxMetadata = {
  eventType: DmOutboxEventType
  runId?: string
  familyKey?: string
}

const nowIso = () => new Date().toISOString()

export const dmOutboxStateFile = (app: AppCfg) => path.join(app.config.runtimeRoot, "orchestrator", "dm-outbox.json")

export const dmBodyFingerprint = (body: string) => createHash("sha256").update(body).digest("hex")

const summarizeAttempts = (attempts: DmOutboxAttempt[]) => ({
  attempts: attempts.length,
  sent: attempts.filter(item => item.state === "sent").length,
  failed: attempts.filter(item => item.state === "failed").length,
  publishFailures: attempts.filter(item => item.state === "failed").length,
})

const normalizeState = (state: DmOutboxState, file: string): DmOutboxState => {
  const attempts = (state.attempts ?? []).slice(-500)
  return {
    version: 1,
    generatedAt: state.generatedAt ?? nowIso(),
    stateFile: state.stateFile ?? file,
    attempts,
    summary: summarizeAttempts(attempts),
  }
}

export const emptyDmOutboxState = (app: AppCfg): DmOutboxState => {
  const file = dmOutboxStateFile(app)
  return {
    version: 1,
    generatedAt: nowIso(),
    stateFile: file,
    attempts: [],
    summary: summarizeAttempts([]),
  }
}

export const readDmOutboxState = async (app: AppCfg): Promise<DmOutboxState> => {
  const file = dmOutboxStateFile(app)
  if (!existsSync(file)) return emptyDmOutboxState(app)
  return normalizeState(JSON.parse(await readFile(file, "utf8")) as DmOutboxState, file)
}

export const writeDmOutboxState = async (state: DmOutboxState) => {
  const next = normalizeState({...state, generatedAt: nowIso()}, state.stateFile)
  await mkdir(path.dirname(next.stateFile), {recursive: true})
  await writeFile(next.stateFile, `${JSON.stringify(next, null, 2)}\n`)
  return next
}

const fieldFromBody = (body: string, name: string) => {
  const match = body.match(new RegExp(`^${name}:\\s*(.+)$`, "im"))
  return match?.[1]?.trim()
}

export const reportMetadataFromBody = (body: string): ReportOutboxMetadata => {
  const runId = fieldFromBody(body, "run")
  const familyKey = fieldFromBody(body, "family")
  if (/^openteam .*digest\b/im.test(body)) return {eventType: "digest", runId, familyKey}
  if (/^observation:/im.test(body) || /^observed:/im.test(body)) return {eventType: "observation-report", runId, familyKey}
  if (runId) return {eventType: "task-report", runId, familyKey}
  return {eventType: "runtime-report", familyKey}
}

export const recordDmOutboxAttempt = async (
  app: AppCfg,
  input: Omit<DmOutboxAttempt, "id" | "retryCount" | "attemptedAt" | "sentAt"> & {
    attemptedAt?: string
    sentAt?: string
  },
) => {
  const state = await readDmOutboxState(app)
  const previousAttempts = state.attempts.filter(item =>
    item.eventType === input.eventType &&
    item.recipient === input.recipient &&
    item.bodyFingerprint === input.bodyFingerprint
  )
  const attemptedAt = input.attemptedAt ?? nowIso()
  const retryCount = previousAttempts.length
  const id = createHash("sha256")
    .update([input.eventType, input.recipient, input.bodyFingerprint, attemptedAt, String(retryCount)].join("\n"))
    .digest("hex")
    .slice(0, 24)
  const attempt: DmOutboxAttempt = {
    ...input,
    id,
    retryCount,
    attemptedAt,
    sentAt: input.state === "sent" ? input.sentAt ?? attemptedAt : input.sentAt,
  }
  const attempts = [...state.attempts, attempt].slice(-500)
  await writeDmOutboxState({...state, attempts})
  return attempt
}

export const recordReportOutboxAttempts = async (
  app: AppCfg,
  body: string,
  recipients: string[],
  outcome: {
    state: "sent" | "failed"
    relayResult?: string
    error?: unknown
  },
) => {
  const metadata = reportMetadataFromBody(body)
  const fingerprint = dmBodyFingerprint(body)
  const error = outcome.error instanceof Error ? `${outcome.error.name}: ${outcome.error.message}` : outcome.error ? String(outcome.error) : undefined
  const attempts: DmOutboxAttempt[] = []
  for (const recipient of recipients) {
    attempts.push(await recordDmOutboxAttempt(app, {
      ...metadata,
      recipient,
      bodyFingerprint: fingerprint,
      state: outcome.state,
      relayResult: outcome.relayResult,
      error,
    }))
  }
  return attempts
}
