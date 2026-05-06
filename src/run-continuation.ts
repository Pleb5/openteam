import {createHash} from "node:crypto"
import {existsSync} from "node:fs"
import {readFile} from "node:fs/promises"
import path from "node:path"
import {evaluateEvidencePolicy} from "./evidence-policy.js"
import type {TaskContinuation, TaskContinuationKind, TaskItem, TaskRunRecord, TaskState, VerificationRunnerResult} from "./types.js"

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "run"

const now = () => new Date().toISOString()

const compactContinuationSource = (record: TaskRunRecord): string => {
  const source = record.continuation?.originRunId || record.continuation?.fromRunId || record.taskId || record.runId
  const readable = slug(source).slice(0, 24) || "run"
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 10)
  return `${readable}-${digest}`
}

const taskId = (kind: TaskContinuationKind, record: TaskRunRecord) =>
  `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${kind}-${compactContinuationSource(record)}`

const taskStates = new Set<TaskState>(["queued", "running", "succeeded", "needs-review", "failed", "interrupted", "stale"])

const sectionText = (text: string, heading: string) => {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return text.match(new RegExp(`^## ${escaped}\\s*\\n+([\\s\\S]*?)(?=\\n## |$)`, "m"))?.[1]?.trim()
}

const lineValue = (text: string, key: string) =>
  text.match(new RegExp(`^- ${key}:\\s*(.+)$`, "m"))?.[1]?.trim()

const readCheckoutHandoffRoot = async (record: TaskRunRecord): Promise<TaskRunRecord | undefined> => {
  const checkout = record.context?.checkout ?? record.continuation?.checkout
  if (!checkout) return undefined
  const file = path.join(checkout, ".openteam", "context", "continuation-summary.md")
  if (!existsSync(file)) return undefined
  const text = await readFile(file, "utf8").catch(() => "")
  const runId = lineValue(text, "original run") ?? lineValue(text, "prior run")
  const task = sectionText(text, "Original Task") ?? sectionText(text, "Prior Task")
  if (!runId || !task || runId === record.runId) return undefined
  const rawState = lineValue(text, "prior state")
  const state = rawState && taskStates.has(rawState as TaskState) ? rawState as TaskState : "stale"
  return {
    version: 1,
    runId,
    runFile: lineValue(text, "original run file") ?? "",
    taskId: runId,
    agentId: record.agentId,
    baseAgentId: record.baseAgentId,
    role: record.role,
    task,
    source: record.source,
    subject: record.subject,
    target: record.target,
    mode: record.mode,
    state,
    startedAt: record.startedAt,
    phases: [],
  }
}

const readPriorRun = async (file?: string) => {
  if (!file || !existsSync(file)) return undefined
  try {
    return JSON.parse(await readFile(file, "utf8")) as TaskRunRecord
  } catch {
    return undefined
  }
}

export const resolveContinuationLineage = async (record: TaskRunRecord, maxDepth = 20) => {
  const chain: TaskRunRecord[] = [record]
  let current: TaskRunRecord | undefined = record
  const seen = new Set<string>()

  for (let depth = 0; current?.continuation?.fromRunFile && depth < maxDepth; depth += 1) {
    const file = current.continuation.fromRunFile
    if (seen.has(file)) break
    seen.add(file)
    const previous = await readPriorRun(file)
    if (!previous) break
    chain.push(previous)
    current = previous
  }

  if (chain.length === 1) {
    const handoffRoot = await readCheckoutHandoffRoot(record)
    if (handoffRoot) chain.push(handoffRoot)
  }

  return chain.reverse()
}

const summarizeResult = (result: VerificationRunnerResult) => {
  const details = result.note ?? result.flow ?? result.url ?? result.blocker ?? result.error ?? result.skippedReason ?? result.logFile ?? ""
  return `${result.id}:${result.state}${result.evidenceType ? `:${result.evidenceType}` : ""}${details ? ` - ${details}` : ""}`
}

export const continuationEvidenceForCarry = (continuation?: TaskContinuation) =>
  continuation?.carryEvidence
    ? continuation.evidenceResults.filter(result => result.state === "succeeded")
    : []

export const createRunContinuation = (
  record: TaskRunRecord,
  kind: TaskContinuationKind,
  carryEvidence = true,
  lineage: TaskRunRecord[] = [record],
): TaskContinuation => {
  if (!record.context?.id) {
    throw new Error(`run ${record.runId} has no repo context to continue`)
  }
  const policy = evaluateEvidencePolicy(record.doneContract, record.verification?.results ?? [])
  const root = lineage[0] ?? record
  const originRunId = record.continuation?.originRunId ?? root.runId
  const originTask = record.continuation?.originTask ?? root.task
  return {
    version: 1,
    kind,
    fromRunId: record.runId,
    originRunId,
    originRunFile: record.continuation?.originRunFile ?? root.runFile,
    originTask,
    priorTask: record.task,
    ancestry: lineage.map(item => ({
      runId: item.runId,
      task: item.task,
      state: item.state,
      failureCategory: item.failureCategory,
    })),
    fromRunFile: record.runFile,
    contextId: record.context.id,
    checkout: record.context.checkout,
    branch: record.context.branch,
    priorState: record.state,
    workerState: record.workerState,
    verificationState: record.verificationState,
    failureCategory: record.failureCategory,
    evidenceLevel: policy.level,
    prEligible: policy.prEligible,
    recommendedAction: policy.recommendedAction,
    missingEvidence: policy.missingEvidence,
    prBlockers: policy.prBlockers,
    carryEvidence,
    evidenceResults: record.verification?.results ?? [],
    subject: record.subject,
    createdAt: now(),
  }
}

export const defaultContinuationTask = (
  record: TaskRunRecord,
  kind: TaskContinuationKind,
  lineage: TaskRunRecord[] = [record],
) => {
  const originalTask = record.continuation?.originTask ?? lineage[0]?.task ?? record.task
  const policy = evaluateEvidencePolicy(record.doneContract, record.verification?.results ?? [])
  if (kind === "repair-evidence") {
    return [
      `Continue from prior run ${record.runId} and repair the missing or weak verification evidence.`,
      `Do not redo unrelated product work unless it is required to verify the existing changes.`,
      `Inspect the current checkout state, run the missing checks, record structured evidence with openteam verify, and publish only if evidence becomes strong and role policy allows it.`,
      policy.missingEvidence.length > 0 ? `Missing evidence: ${policy.missingEvidence.join("; ")}` : "",
      `Original task: ${originalTask}`,
    ].filter(Boolean).join("\n")
  }

  if (kind === "retry") {
    return [
      `Retry prior run ${record.runId} because it failed before implementation progress was recorded.`,
      `Start from the original task, inspect the prepared checkout normally, record fresh verification evidence, and publish only if evidence becomes strong and role policy allows it.`,
      `Original task: ${originalTask}`,
    ].join("\n")
  }

  return [
    `Continue from prior run ${record.runId}.`,
    `Inspect the current checkout state and prior evidence, finish any incomplete task work, record structured verification evidence, and publish only if evidence becomes strong and role policy allows it.`,
    `Original task: ${originalTask}`,
  ].join("\n")
}

export const createContinuationTaskItem = (
  record: TaskRunRecord,
  options: {
    kind: TaskContinuationKind
    task?: string
    model?: string
    modelProfile?: string
    modelVariant?: string
    carryEvidence?: boolean
  },
  lineage: TaskRunRecord[] = [record],
): TaskItem => {
  const agentId = record.baseAgentId || record.agentId
  const continuation = createRunContinuation(record, options.kind, options.carryEvidence ?? options.kind !== "retry", lineage)
  const priorModelFailed = /^(model-|opencode-auth-)/.test(record.failureCategory ?? "")
  return {
    id: taskId(options.kind, record),
    task: options.task?.trim() || defaultContinuationTask(record, options.kind, lineage),
    createdAt: now(),
    state: "queued",
    agentId,
    target: record.target,
    mode: record.mode,
    model: options.model || (priorModelFailed ? undefined : record.model),
    modelProfile: options.modelProfile || (priorModelFailed ? undefined : record.requestedModelProfile),
    modelVariant: options.modelVariant || record.requestedModelVariant,
    continuation,
    subject: record.subject ? {
      kind: record.subject.kind,
      eventId: record.subject.encodedEvent ?? record.subject.eventId,
      repoTarget: record.subject.repoTarget,
      path: record.subject.path,
    } : undefined,
    source: {kind: "local"},
  }
}

export const createContinuationTaskItemWithLineage = async (
  record: TaskRunRecord,
  options: Parameters<typeof createContinuationTaskItem>[1],
) => createContinuationTaskItem(record, options, await resolveContinuationLineage(record))

export const continuationPromptLines = (continuation?: TaskContinuation) => {
  if (!continuation) return []
  const results = continuation.evidenceResults.slice(0, 12).map(summarizeResult)
  return [
    `Continuation mode: ${continuation.kind}`,
    continuation.originRunId ? `Original run: ${continuation.originRunId}` : "",
    continuation.originTask ? `Original task: ${continuation.originTask}` : "",
    `Immediate prior run: ${continuation.fromRunId}`,
    continuation.priorTask ? `Immediate prior task: ${continuation.priorTask}` : "",
    `Prior context: ${continuation.contextId}`,
    `Prior checkout: withheld; sanitized context has been copied into the current checkout when available.`,
    `Sanitized continuation handoff: .openteam/context/continuation-summary.md`,
    `Prior branch: ${continuation.branch ?? "(unknown)"}`,
    `Prior state: ${continuation.priorState}`,
    continuation.workerState ? `Prior worker state: ${continuation.workerState}` : "",
    continuation.verificationState ? `Prior verification state: ${continuation.verificationState}` : "",
    continuation.failureCategory ? `Prior failure category: ${continuation.failureCategory}` : "",
    continuation.evidenceLevel ? `Prior evidence level: ${continuation.evidenceLevel}` : "",
    continuation.prEligible !== undefined ? `Prior PR eligible: ${continuation.prEligible ? "yes" : "no"}` : "",
    continuation.recommendedAction ? `Prior recommended action: ${continuation.recommendedAction}` : "",
    continuation.missingEvidence.length > 0 ? `Prior missing evidence: ${continuation.missingEvidence.join("; ")}` : "",
    continuation.prBlockers.length > 0 ? `Prior PR blockers: ${continuation.prBlockers.join("; ")}` : "",
    continuation.kind === "retry" ? `Retry mode requires that the prior run made no implementation progress; treat prior logs as failure context only and record fresh evidence for this run.` : "",
    continuation.carryEvidence
      ? `Prior successful verification results have been carried into this checkout as context; failed or blocked prior results remain prompt context only. Add new evidence for what you verify now.`
      : `Prior verification results were not carried forward; record fresh evidence for this run.`,
    continuation.subject ? `Prior review subject: ${continuation.subject.kind} ${continuation.subject.encodedEvent ?? continuation.subject.eventId}${continuation.subject.path ? ` at ${continuation.subject.path}` : ""}` : "",
    ...(continuation.ancestry ?? []).slice(0, 10).map(item => `Continuation ancestry: ${item.runId} ${item.state}${item.failureCategory ? ` ${item.failureCategory}` : ""} - ${item.task}`),
    ...results.map(result => `Prior evidence: ${result}`),
  ].filter(Boolean)
}
