import {existsSync} from "node:fs"
import {mkdir, readFile, writeFile} from "node:fs/promises"
import path from "node:path"
import {diagnoseRun} from "./commands/runs.js"
import {evaluateEvidencePolicy, type EvidencePolicyView} from "./evidence-policy.js"
import {redactSensitiveText} from "./log-redaction.js"
import {loadRepoRegistry} from "./repo.js"
import {resolveRunFamilyKey} from "./reporting-policy.js"
import type {AppCfg, TaskItem, TaskRunRecord} from "./types.js"

type FamilyRunObservation = {
  runId: string
  state: string
  failureCategory?: string
  evidenceLevel: string
  prEligible: boolean
  recommendedAction?: string
  observedAt: string
}

export type RunFamilyRecord = {
  familyKey: string
  attemptCount: number
  failureCounts: Record<string, number>
  runs: Record<string, FamilyRunObservation>
  lastFailureCategory?: string
  lastEvidenceLevel?: string
  lastRecommendedAction?: string
  lastLaunchedCommand?: string
  lastLaunchedAt?: string
  lastBlockedAt?: string
  blockedCount: number
  forcedCount: number
  updatedAt: string
}

export type RunFamilyState = {
  version: 1
  generatedAt: string
  stateFile: string
  families: Record<string, RunFamilyRecord>
}

export type ContinuationGateDecision = {
  allowed: boolean
  forced: boolean
  familyKey: string
  family: RunFamilyRecord
  policy: EvidencePolicyView
  blockers: string[]
  warnings: string[]
  state: RunFamilyState
}

type ContinuationGateOptions = {
  explicitTask?: boolean
  force?: boolean
  command?: string
  now?: Date
}

const statePath = (app: AppCfg) =>
  path.join(app.config.runtimeRoot, "orchestrator", "run-families.json")

const nowIso = (date = new Date()) => date.toISOString()

export const emptyRunFamilyState = (app: AppCfg): RunFamilyState => ({
  version: 1,
  generatedAt: nowIso(),
  stateFile: statePath(app),
  families: {},
})

export const readRunFamilyState = async (app: AppCfg): Promise<RunFamilyState> => {
  const file = statePath(app)
  if (!existsSync(file)) return emptyRunFamilyState(app)
  const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<RunFamilyState>
  const generatedAt = parsed.generatedAt ?? nowIso()
  const families = Object.fromEntries(
    Object.entries(parsed.families ?? {}).map(([key, family]) => {
      const normalized = {
        ...emptyFamily(family.familyKey ?? key, generatedAt),
        ...family,
        familyKey: family.familyKey ?? key,
        runs: family.runs ?? {},
        failureCounts: family.failureCounts ?? {},
        blockedCount: family.blockedCount ?? 0,
        forcedCount: family.forcedCount ?? 0,
      }
      recomputeFamily(normalized)
      return [key, normalized]
    }),
  )
  return {
    version: 1,
    generatedAt,
    stateFile: file,
    families,
  }
}

export const writeRunFamilyState = async (state: RunFamilyState) => {
  state.generatedAt = nowIso()
  await mkdir(path.dirname(state.stateFile), {recursive: true})
  await writeFile(state.stateFile, `${JSON.stringify(state, null, 2)}\n`)
  return state.stateFile
}

const oneLine = (value: string | undefined) =>
  (value ?? "").replace(/\s+/g, " ").trim()

const lower = (value: string | undefined) => oneLine(value).toLowerCase()

const truncate = (value: string | undefined, max = 180) => {
  const line = oneLine(value)
  return line.length > max ? `${line.slice(0, Math.max(0, max - 3))}...` : line
}

const readRunFile = async (file?: string) => {
  if (!file || !existsSync(file)) return undefined
  try {
    return JSON.parse(await readFile(file, "utf8")) as TaskRunRecord
  } catch {
    return undefined
  }
}

const familyChain = async (record: TaskRunRecord) => {
  const chain: TaskRunRecord[] = [record]
  let current: TaskRunRecord | undefined = record
  const seen = new Set<string>()

  for (let depth = 0; current?.continuation?.fromRunFile && depth < 20; depth += 1) {
    const file = current.continuation.fromRunFile
    if (seen.has(file)) break
    seen.add(file)
    const previous = await readRunFile(file)
    if (!previous) break
    chain.push(previous)
    current = previous
  }

  return chain.reverse()
}

const emptyFamily = (familyKey: string, observedAt: string): RunFamilyRecord => ({
  familyKey,
  attemptCount: 0,
  failureCounts: {},
  runs: {},
  blockedCount: 0,
  forcedCount: 0,
  updatedAt: observedAt,
})

const recomputeFamily = (family: RunFamilyRecord) => {
  const runs = Object.values(family.runs)
  family.attemptCount = runs.length
  family.failureCounts = runs.reduce<Record<string, number>>((acc, run) => {
    if (run.failureCategory) acc[run.failureCategory] = (acc[run.failureCategory] ?? 0) + 1
    return acc
  }, {})
  const latest = runs.sort((a, b) => a.observedAt.localeCompare(b.observedAt)).at(-1)
  family.lastFailureCategory = latest?.failureCategory ?? family.lastFailureCategory
  family.lastEvidenceLevel = latest?.evidenceLevel ?? family.lastEvidenceLevel
  family.lastRecommendedAction = latest?.recommendedAction ?? family.lastRecommendedAction
  family.updatedAt = latest?.observedAt ?? family.updatedAt
}

const observeRun = (
  family: RunFamilyRecord,
  record: TaskRunRecord,
  policy: EvidencePolicyView,
  observedAt: string,
) => {
  family.runs[record.runId] = {
    runId: record.runId,
    state: record.state,
    failureCategory: record.failureCategory,
    evidenceLevel: policy.level,
    prEligible: policy.prEligible,
    recommendedAction: policy.recommendedAction,
    observedAt,
  }
  recomputeFamily(family)
}

const genericContinuationTask = (task: string) =>
  /^(continue|continue from prior run|finish|finish it|finish the work|do the rest|keep going|resume)$/i.test(oneLine(task))

const taskStatesMaterialDifference = (
  record: TaskRunRecord,
  item: TaskItem,
  policy: EvidencePolicyView,
  explicitTask: boolean,
) => {
  const kind = item.continuation?.kind
  const task = lower(item.task)
  if (!task || genericContinuationTask(task)) return false

  if (kind === "repair-evidence") {
    return (
      task.includes("evidence") ||
      task.includes("verify") ||
      task.includes("verification") ||
      task.includes("missing") ||
      task.includes("weak") ||
      policy.missingEvidence.some(item => task.includes(lower(item).split(" ")[0] ?? ""))
    )
  }

  if (!explicitTask) return false

  const materialPatterns = [
    /\bevidence\b/,
    /\bverify|verification\b/,
    /\bmissing\b/,
    /\bweak\b/,
    /\bfailed|failure\b/,
    /\bblocked|blocker\b/,
    /\bnarrow|scope|only|instead|different\b/,
    /\brepair|collect|record\b/,
    /\btest|check|build|lint|repo-native|browser|dev-server\b/,
  ]
  if (materialPatterns.some(pattern => pattern.test(task))) return true
  if (record.failureCategory && task.includes(lower(record.failureCategory))) return true
  if (policy.missingEvidence.some(item => task.includes(lower(item).split(" ")[0] ?? ""))) return true

  return task.length >= 32 && task !== lower(record.task)
}

const contextGate = async (app: AppCfg, record: TaskRunRecord, item: TaskItem) => {
  const blockers: string[] = []
  const warnings: string[] = []
  const contextId = item.continuation?.contextId ?? record.context?.id
  if (!contextId) {
    return {blockers: ["continuation run has no repo context to continue"], warnings}
  }

  const registry = await loadRepoRegistry(app)
  const context = registry.contexts[contextId]
  if (!context) {
    return {blockers: [`continuation context not found: ${contextId}`], warnings}
  }

  const checkout = context.checkout || item.continuation?.checkout || record.context?.checkout
  if (!checkout || !existsSync(checkout)) {
    blockers.push(`continuation context ${contextId} checkout is missing: ${checkout || "(unknown)"}`)
  }

  const requestedMode = item.mode ?? context.mode
  if (requestedMode !== context.mode) {
    blockers.push(`continuation context ${contextId} was created for ${context.mode} mode; requested ${requestedMode}`)
  }

  if (context.state !== "idle") {
    const leaseMatchesRun = Boolean(
      context.lease &&
      context.lease.workerId === record.agentId &&
      context.lease.jobId === record.taskId,
    )
    const stalePrior = record.state === "stale" || record.state === "running"
    if (leaseMatchesRun && stalePrior) {
      warnings.push(`continuation context ${contextId} is still leased by the prior run; stale cleanup must release it before launch`)
    } else {
      blockers.push(`continuation context ${contextId} is ${context.state}${context.lease ? ` by ${context.lease.workerId}/${context.lease.jobId}` : ""}`)
    }
  }

  return {blockers, warnings}
}

export const evaluateContinuationGate = async (
  app: AppCfg,
  record: TaskRunRecord,
  item: TaskItem,
  options: ContinuationGateOptions = {},
): Promise<ContinuationGateDecision> => {
  const observedAt = nowIso(options.now)
  const state = await readRunFamilyState(app)
  const familyKey = await resolveRunFamilyKey(record)
  const family = state.families[familyKey] ?? emptyFamily(familyKey, observedAt)
  state.families[familyKey] = family

  for (const familyRecord of await familyChain(record)) {
    observeRun(family, familyRecord, evaluateEvidencePolicy(familyRecord.doneContract, familyRecord.verification?.results ?? []), observedAt)
  }

  const policy = evaluateEvidencePolicy(record.doneContract, record.verification?.results ?? [])
  const blockers: string[] = []
  const warnings: string[] = []
  const context = await contextGate(app, record, item)
  blockers.push(...context.blockers)
  warnings.push(...context.warnings)

  const diagnosis = await diagnoseRun(app, record).catch(() => undefined)
  if (record.state === "running" && !diagnosis?.stale) {
    blockers.push(`run ${record.runId} is still running; stop it or wait for it to finish before continuing`)
  }
  const carriedEvidence = item.continuation?.evidenceResults.filter(result => result.state === "succeeded") ?? []
  if ((record.state === "stale" || diagnosis?.stale) && policy.level === "none" && carriedEvidence.length === 0) {
    blockers.push(`prior run ${record.runId} is stale and has no carried evidence; report the stale blocker or use --force with a genuinely different task`)
  }

  const category = record.failureCategory
  const categoryCount = category ? family.failureCounts[category] ?? 0 : 0
  if (category && categoryCount >= 2) {
    blockers.push(`family ${familyKey} already has ${categoryCount} attempts ending with ${category}; report a blocker instead of launching another similar continuation`)
  }

  if (!taskStatesMaterialDifference(record, item, policy, Boolean(options.explicitTask))) {
    blockers.push("continuation task must state what is different from the prior attempt")
  }

  if (item.continuation?.kind === "repair-evidence" && policy.level === "strong") {
    blockers.push("repair-evidence is not needed because the prior run already has strong evidence")
  }

  const forced = Boolean(options.force && blockers.length > 0)
  return {
    allowed: blockers.length === 0 || forced,
    forced,
    familyKey,
    family,
    policy,
    blockers: Array.from(new Set(blockers)),
    warnings,
    state,
  }
}

export const recordContinuationLaunch = (
  decision: ContinuationGateDecision,
  command: string,
  launch?: {
    runId: string
    state?: string
    failureCategory?: string
  },
  date = new Date(),
) => {
  const family = decision.family
  family.lastLaunchedCommand = truncate(command)
  family.lastLaunchedAt = nowIso(date)
  family.updatedAt = family.lastLaunchedAt
  if (launch) {
    family.runs[launch.runId] = {
      runId: launch.runId,
      state: launch.state ?? "queued",
      failureCategory: launch.failureCategory,
      evidenceLevel: decision.policy.level,
      prEligible: decision.policy.prEligible,
      recommendedAction: decision.policy.recommendedAction,
      observedAt: family.lastLaunchedAt,
    }
    recomputeFamily(family)
  }
  if (decision.forced) family.forcedCount += 1
}

const tailLines = (text: string, count: number) =>
  text.split(/\r?\n/).slice(-count).join("\n").trim()

export const continuationHandoffPath = (checkout: string) =>
  path.join(checkout, ".openteam", "continuation-summary.md")

export const writeContinuationHandoff = async (
  app: AppCfg,
  record: TaskRunRecord,
  item: TaskItem,
) => {
  const checkout = item.continuation?.checkout ?? record.context?.checkout
  if (!checkout) return undefined
  const diagnosis = await diagnoseRun(app, record).catch(() => undefined)
  const policy = evaluateEvidencePolicy(record.doneContract, record.verification?.results ?? [])
  const logTail = record.logs?.opencode && existsSync(record.logs.opencode)
    ? tailLines(redactSensitiveText(await readFile(record.logs.opencode, "utf8").catch(() => "")), 80)
    : ""
  const file = continuationHandoffPath(checkout)
  await mkdir(path.dirname(file), {recursive: true})
  await writeFile(file, `${[
    "# Continuation Handoff",
    "",
    `- prior run: ${record.runId}`,
    `- prior state: ${record.state}`,
    record.failureCategory ? `- prior failure category: ${record.failureCategory}` : "",
    diagnosis?.staleFailureCategory ? `- stale category: ${diagnosis.staleFailureCategory}` : "",
    `- evidence level: ${policy.level}`,
    `- PR eligible: ${policy.prEligible ? "yes" : "no"}`,
    `- recommended action: ${policy.recommendedAction}`,
    diagnosis?.reasons.length ? `- diagnosis: ${diagnosis.reasons.join("; ")}` : "",
    "",
    "## Prior Task",
    "",
    redactSensitiveText(record.task),
    "",
    "## Continuation Task",
    "",
    redactSensitiveText(item.task),
    logTail ? "## Sanitized Prior Log Tail" : "",
    logTail ? "" : "",
    logTail,
  ].join("\n")}\n`)
  return file
}

export const recordContinuationBlock = (
  decision: ContinuationGateDecision,
  date = new Date(),
) => {
  const family = decision.family
  family.blockedCount += 1
  family.lastBlockedAt = nowIso(date)
  family.updatedAt = family.lastBlockedAt
}

export const summarizeContinuationGate = (decision: ContinuationGateDecision) => ({
  allowed: decision.allowed,
  forced: decision.forced,
  familyKey: decision.familyKey,
  attemptCount: decision.family.attemptCount,
  failureCounts: decision.family.failureCounts,
  lastFailureCategory: decision.family.lastFailureCategory,
  lastEvidenceLevel: decision.family.lastEvidenceLevel,
  lastRecommendedAction: decision.family.lastRecommendedAction,
  blockers: decision.blockers,
  warnings: decision.warnings,
  stateFile: decision.state.stateFile,
})

export const formatContinuationGateError = (decision: ContinuationGateDecision) => [
  `continuation blocked for family ${decision.familyKey}`,
  ...decision.blockers.map(blocker => `- ${blocker}`),
  "Use --force only when the next attempt is intentionally different and the operator accepts the risk.",
].join("\n")
