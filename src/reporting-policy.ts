import {existsSync} from "node:fs"
import {mkdir, readFile, writeFile} from "node:fs/promises"
import path from "node:path"
import type {AppCfg, LaunchResult, ReportingCfg, TaskRunRecord} from "./types.js"
import type {RunObservationEvent, RunObservationSnapshot} from "./run-observer.js"

type ObservationMode = NonNullable<ReportingCfg["dmObservationMode"]>

export type DmReportState = {
  version: 1
  generatedAt: string
  stateFile: string
  runs: Record<string, {
    familyKey: string
    lastFingerprint?: string
    lastReportedState?: string
    lastReportedFailureCategory?: string
    lastReportedEvidenceLevel?: string
    lastReportedRecommendedAction?: string
    lastReportedAt?: string
    lastWarningAt?: string
    reportCount: number
  }>
  families: Record<string, {
    lastNeedsReviewCategory?: string
    lastNeedsReviewAt?: string
  }>
  digest: {
    lastDigestAt?: string
    pending: DigestItem[]
  }
}

type DigestItem = {
  runId: string
  familyKey: string
  agentId: string
  role: string
  state: string
  failureCategory?: string
  target?: string
  mode?: string
  evidenceLevel?: string
  prEligible?: boolean
  reason: string
  next: string
  observedAt: string
}

type ReportingOptions = {
  mode?: ObservationMode
  digestIntervalMs?: number
  warningThrottleMs?: number
  now?: Date
}

type TaskReportOptions = {
  kind: "started" | "browser-url" | "terminal" | "failed"
  state?: string
  failureCategory?: string
  evidenceLevel?: string
  prEligible?: boolean
  recommendedAction?: string
  url?: string
  error?: string
  logFile?: string
  artifact?: string
  result?: LaunchResult
}

const DEFAULT_DIGEST_INTERVAL_MS = 30 * 60_000
const DEFAULT_WARNING_THROTTLE_MS = 30 * 60_000
const TERMINAL_STATES = new Set(["succeeded", "failed", "stale", "needs-review", "interrupted"])

const oneLine = (value: string | undefined, fallback = "") =>
  (value ?? fallback).replace(/\s+/g, " ").trim()

const truncate = (value: string | undefined, max = 96) => {
  const line = oneLine(value)
  return line.length > max ? `${line.slice(0, Math.max(0, max - 3))}...` : line
}

const compactTarget = (value: string | undefined) => {
  const line = oneLine(value, "(none)")
  if (line.startsWith("nostr://")) {
    const match = line.match(/^nostr:\/\/([^/]+)\/(.+)$/)
    if (match) return `nostr://${match[1].slice(0, 12)}.../${match[2]}`
  }
  if (line.startsWith("30617:")) {
    const parts = line.split(":")
    if (parts.length >= 3) return `${parts[0]}:${parts[1].slice(0, 12)}...:${parts.slice(2).join(":")}`
  }
  return truncate(line, 120)
}

const reportStatePath = (app: AppCfg) =>
  path.join(app.config.runtimeRoot, "orchestrator", "dm-report-state.json")

export const emptyDmReportState = (app: AppCfg): DmReportState => ({
  version: 1,
  generatedAt: new Date().toISOString(),
  stateFile: reportStatePath(app),
  runs: {},
  families: {},
  digest: {
    pending: [],
  },
})

export const readDmReportState = async (app: AppCfg): Promise<DmReportState> => {
  const file = reportStatePath(app)
  if (!existsSync(file)) return emptyDmReportState(app)
  return JSON.parse(await readFile(file, "utf8")) as DmReportState
}

export const writeDmReportState = async (state: DmReportState) => {
  state.generatedAt = new Date().toISOString()
  await mkdir(path.dirname(state.stateFile), {recursive: true})
  await writeFile(state.stateFile, `${JSON.stringify(state, null, 2)}\n`)
}

const readRunRecord = async (file?: string): Promise<TaskRunRecord | undefined> => {
  if (!file || !existsSync(file)) return undefined
  try {
    return JSON.parse(await readFile(file, "utf8")) as TaskRunRecord
  } catch {
    return undefined
  }
}

export const resolveRunFamilyKey = async (record: TaskRunRecord) => {
  let current: TaskRunRecord | undefined = record
  let fallback = record.continuation?.fromRunId ?? record.runId
  const seen = new Set<string>()

  for (let depth = 0; current?.continuation && depth < 20; depth += 1) {
    fallback = current.continuation.fromRunId || fallback
    if (!current.continuation.fromRunFile || seen.has(current.continuation.fromRunFile)) break
    seen.add(current.continuation.fromRunFile)
    const previous = await readRunRecord(current.continuation.fromRunFile)
    if (!previous) break
    current = previous
    if (!current.continuation) return current.runId
  }

  return current?.continuation ? fallback : current?.runId ?? fallback
}

const evidenceText = (level?: string, prEligible?: boolean) => {
  if (!level && prEligible === undefined) return undefined
  return `${level ?? "unknown"}, PR ${prEligible ? "yes" : "no"}`
}

const nextForState = (runId: string, state: string, recommended?: string) => {
  if (state === "needs-review") return `openteam runs evidence ${runId}`
  if (state === "failed" || state === "stale" || state === "interrupted") return recommended ? truncate(recommended, 120) : `openteam runs show ${runId}`
  if (state === "running") return `openteam runs observe ${runId}`
  return recommended ? truncate(recommended, 120) : `openteam runs show ${runId}`
}

const failureFor = (snapshot: RunObservationSnapshot) =>
  snapshot.failureCategory ||
  (snapshot.opencodeBlockedKind ? `opencode-${snapshot.opencodeBlockedKind}-blocked` : undefined) ||
  (snapshot.opencodeStallSeverity ? `opencode-idle-${snapshot.opencodeStallSeverity}` : undefined) ||
  (snapshot.state === "stale" ? snapshot.staleReasons[0] : undefined)

export const formatTaskRunReport = async (
  record: TaskRunRecord,
  options: TaskReportOptions,
) => {
  const state = options.state ?? options.result?.state ?? record.state
  const failureCategory = options.failureCategory ?? record.failureCategory
  const family = await resolveRunFamilyKey(record)
  const evidence = evidenceText(options.evidenceLevel ?? options.result?.evidenceLevel, options.prEligible ?? options.result?.prEligible)
  const lifecycleWhy = options.kind === "started"
    ? "run accepted"
    : options.kind === "browser-url"
      ? "browser URL available"
      : undefined
  const why = options.error
    ? truncate(options.error, 180)
    : failureCategory
      ? truncate(failureCategory, 120)
      : lifecycleWhy ?? options.recommendedAction ?? options.result?.recommendedAction
  const next = options.kind === "started"
    ? `openteam runs observe ${record.runId}`
    : nextForState(record.runId, state, options.recommendedAction ?? options.result?.recommendedAction)

  const lines = [
    `[${record.agentId}] ${state}${failureCategory ? ` ${failureCategory}` : ""}`,
    `run: ${record.runId}`,
    `family: ${family}`,
    `target: ${compactTarget(record.target ?? options.result?.target)}`,
    `mode: ${record.mode ?? options.result?.mode ?? "(unset)"}`,
    `task: ${truncate(record.task || record.taskId)}`,
    evidence ? `evidence: ${evidence}` : "",
    options.url ? `url: ${options.url}` : "",
    why ? `why: ${why}` : "",
    options.artifact ? `artifact: ${options.artifact}` : "",
    options.logFile || options.result?.logFile ? `log: ${options.logFile ?? options.result?.logFile}` : "",
    record.context?.id ? `context: ${record.context.id}` : "",
    `next: ${next}`,
  ]
  return lines.filter(Boolean).join("\n")
}

const observationReason = (event: RunObservationEvent) => {
  const failure = failureFor(event.snapshot)
  if (failure) return truncate(failure, 140)
  const transition = event.transitions.find(item => item.severity === "critical") ??
    event.transitions.find(item => item.severity === "warning") ??
    event.transitions[0]
  return truncate(transition?.message, 140)
}

const formatObservationReport = (event: RunObservationEvent) => {
  const snapshot = event.snapshot
  const failure = failureFor(snapshot)
  const next = nextForState(snapshot.runId, snapshot.state, snapshot.recommendedAction)
  const evidence = evidenceText(snapshot.evidenceLevel, snapshot.prEligible)
  return [
    `[${snapshot.agentId}] ${snapshot.state}${failure ? ` ${failure}` : ""}`,
    `run: ${snapshot.runId}`,
    `family: ${snapshot.familyKey ?? snapshot.runId}`,
    `target: ${compactTarget(snapshot.target)}`,
    `mode: ${snapshot.mode ?? "(unset)"}`,
    `task: ${truncate(snapshot.task ?? snapshot.taskId)}`,
    evidence ? `evidence: ${evidence}` : "",
    snapshot.devUrl && snapshot.devHealthy ? `url: ${snapshot.devUrl}` : "",
    snapshot.opencodeLogAgeMs !== undefined ? `opencode idle: ${Math.round(snapshot.opencodeLogAgeMs / 60_000)}m${snapshot.opencodeLastLine ? ` last=${truncate(snapshot.opencodeLastLine, 80)}` : ""}` : "",
    `why: ${observationReason(event)}`,
    snapshot.contextId && (snapshot.state === "stale" || snapshot.contextLeaseMatchesRun === false) ? `context: ${snapshot.contextId}` : "",
    `next: ${next}`,
  ].filter(Boolean).join("\n")
}

const digestLine = (item: DigestItem) =>
  `- ${item.state} ${item.agentId} run=${item.runId} family=${item.familyKey} target=${compactTarget(item.target)} mode=${item.mode ?? "(unset)"} evidence=${item.evidenceLevel ?? "unknown"} why=${truncate(item.reason, 80)} next="${item.next}"`

const pendingKey = (item: DigestItem) =>
  `${item.runId}:${item.state}:${item.failureCategory ?? ""}:${item.evidenceLevel ?? ""}:${item.reason}`

const addPendingDigest = (state: DmReportState, item: DigestItem) => {
  const keys = new Set(state.digest.pending.map(pendingKey))
  if (!keys.has(pendingKey(item))) {
    state.digest.pending.push(item)
  }
  state.digest.pending = state.digest.pending.slice(-100)
}

const optionsFromReporting = (reporting: ReportingCfg, options: ReportingOptions = {}) => ({
  mode: options.mode ?? reporting.dmObservationMode ?? "terminal",
  digestIntervalMs: options.digestIntervalMs ?? reporting.dmDigestIntervalMs ?? DEFAULT_DIGEST_INTERVAL_MS,
  warningThrottleMs: options.warningThrottleMs ?? reporting.dmWarningThrottleMs ?? DEFAULT_WARNING_THROTTLE_MS,
  now: options.now ?? new Date(),
})

const hasActionableTransition = (event: RunObservationEvent) =>
  event.transitions.some(transition =>
    (transition.field === "state" && TERMINAL_STATES.has(String(transition.to))) ||
    transition.severity === "critical" ||
    transition.severity === "warning",
  )

const fingerprintFor = (snapshot: RunObservationSnapshot) =>
  [
    snapshot.state,
    snapshot.failureCategory ?? "",
    snapshot.evidenceLevel,
    snapshot.opencodeBlockedKind ?? "",
    snapshot.opencodeStallSeverity ?? "",
    snapshot.prEligible ? "pr-yes" : "pr-no",
    snapshot.recommendedAction ?? "",
  ].join("|")

export const applyObservationReportPolicy = (
  state: DmReportState,
  event: RunObservationEvent,
  reporting: ReportingCfg,
  options: ReportingOptions = {},
) => {
  const config = optionsFromReporting(reporting, options)
  const snapshot = event.snapshot
  const familyKey = snapshot.familyKey ?? snapshot.runId
  const fingerprint = fingerprintFor(snapshot)
  const previous = state.runs[snapshot.runId]
  const family = state.families[familyKey] ?? {}
  const nowIso = config.now.toISOString()
  const terminal = TERMINAL_STATES.has(snapshot.state)
  const critical = event.transitions.some(transition => transition.severity === "critical")
  const warning = event.transitions.some(transition => transition.severity === "warning")
  const repeat = previous?.lastFingerprint === fingerprint
  const warningThrottled = warning && previous?.lastWarningAt
    ? config.now.getTime() - Date.parse(previous.lastWarningAt) < config.warningThrottleMs
    : false
  const repeatedNeedsReview = snapshot.state === "needs-review" &&
    Boolean(family.lastNeedsReviewAt) &&
    family.lastNeedsReviewCategory === (snapshot.failureCategory ?? "")

  let report: string | undefined
  let reported = false

  if (!repeat && hasActionableTransition(event)) {
    if (config.mode === "verbose") {
      report = formatObservationReport(event)
    } else if ((terminal || critical) && !repeatedNeedsReview) {
      report = formatObservationReport(event)
    } else if (config.mode === "digest" && warning && !warningThrottled) {
      addPendingDigest(state, {
        runId: snapshot.runId,
        familyKey,
        agentId: snapshot.agentId,
        role: snapshot.role,
        state: snapshot.state,
        failureCategory: snapshot.failureCategory,
        target: snapshot.target,
        mode: snapshot.mode,
        evidenceLevel: snapshot.evidenceLevel,
        prEligible: snapshot.prEligible,
        reason: observationReason(event),
        next: nextForState(snapshot.runId, snapshot.state, snapshot.recommendedAction),
        observedAt: snapshot.observedAt,
      })
    }
  }

  if (report) {
    reported = true
  }

  state.runs[snapshot.runId] = {
    familyKey,
    lastFingerprint: fingerprint,
    lastReportedState: reported ? snapshot.state : previous?.lastReportedState,
    lastReportedFailureCategory: reported ? snapshot.failureCategory : previous?.lastReportedFailureCategory,
    lastReportedEvidenceLevel: reported ? snapshot.evidenceLevel : previous?.lastReportedEvidenceLevel,
    lastReportedRecommendedAction: reported ? snapshot.recommendedAction : previous?.lastReportedRecommendedAction,
    lastReportedAt: reported ? nowIso : previous?.lastReportedAt,
    lastWarningAt: warning ? nowIso : previous?.lastWarningAt,
    reportCount: (previous?.reportCount ?? 0) + (reported ? 1 : 0),
  }

  if (snapshot.state === "needs-review" && reported) {
    state.families[familyKey] = {
      ...family,
      lastNeedsReviewCategory: snapshot.failureCategory ?? "",
      lastNeedsReviewAt: nowIso,
    }
  } else if (!state.families[familyKey]) {
    state.families[familyKey] = family
  }

  return {report, reported}
}

export const buildDueObservationDigest = (
  state: DmReportState,
  reporting: ReportingCfg,
  options: ReportingOptions = {},
) => {
  const config = optionsFromReporting(reporting, options)
  if (config.mode !== "digest" || state.digest.pending.length === 0) return undefined
  const last = state.digest.lastDigestAt ? Date.parse(state.digest.lastDigestAt) : 0
  if (last && config.now.getTime() - last < config.digestIntervalMs) return undefined

  const counts = state.digest.pending.reduce<Record<string, number>>((acc, item) => {
    acc[item.state] = (acc[item.state] ?? 0) + 1
    return acc
  }, {})
  const top = state.digest.pending.slice(0, 8)
  const body = [
    "openteam run digest",
    ...Object.entries(counts).map(([name, count]) => `${name}: ${count}`),
    ...top.map(digestLine),
    "next: openteam status",
  ].join("\n")

  state.digest.pending = state.digest.pending.slice(top.length)
  state.digest.lastDigestAt = config.now.toISOString()
  return body
}
