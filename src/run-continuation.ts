import {evaluateEvidencePolicy} from "./evidence-policy.js"
import type {TaskContinuation, TaskContinuationKind, TaskItem, TaskRunRecord, VerificationRunnerResult} from "./types.js"

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "run"

const now = () => new Date().toISOString()

const taskId = (kind: TaskContinuationKind, record: TaskRunRecord) =>
  `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${kind}-${slug(record.taskId || record.runId)}`

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
): TaskContinuation => {
  if (!record.context?.id) {
    throw new Error(`run ${record.runId} has no repo context to continue`)
  }
  const policy = evaluateEvidencePolicy(record.doneContract, record.verification?.results ?? [])
  return {
    version: 1,
    kind,
    fromRunId: record.runId,
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
) => {
  const policy = evaluateEvidencePolicy(record.doneContract, record.verification?.results ?? [])
  if (kind === "repair-evidence") {
    return [
      `Continue from prior run ${record.runId} and repair the missing or weak verification evidence.`,
      `Do not redo unrelated product work unless it is required to verify the existing changes.`,
      `Inspect the current checkout state, run the missing checks, record structured evidence with openteam verify, and publish only if evidence becomes strong and role policy allows it.`,
      policy.missingEvidence.length > 0 ? `Missing evidence: ${policy.missingEvidence.join("; ")}` : "",
      `Original task: ${record.task}`,
    ].filter(Boolean).join("\n")
  }

  if (kind === "retry") {
    return [
      `Retry prior run ${record.runId} because it failed before implementation progress was recorded.`,
      `Start from the original task, inspect the prepared checkout normally, record fresh verification evidence, and publish only if evidence becomes strong and role policy allows it.`,
      `Original task: ${record.task}`,
    ].join("\n")
  }

  return [
    `Continue from prior run ${record.runId}.`,
    `Inspect the current checkout state and prior evidence, finish any incomplete task work, record structured verification evidence, and publish only if evidence becomes strong and role policy allows it.`,
    `Original task: ${record.task}`,
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
): TaskItem => {
  const agentId = record.baseAgentId || record.agentId
  const continuation = createRunContinuation(record, options.kind, options.carryEvidence ?? options.kind !== "retry")
  const priorModelFailed = /^(model-|opencode-auth-)/.test(record.failureCategory ?? "")
  return {
    id: taskId(options.kind, record),
    task: options.task?.trim() || defaultContinuationTask(record, options.kind),
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

export const continuationPromptLines = (continuation?: TaskContinuation) => {
  if (!continuation) return []
  const results = continuation.evidenceResults.slice(0, 12).map(summarizeResult)
  return [
    `Continuation mode: ${continuation.kind}`,
    `Prior run: ${continuation.fromRunId}`,
    `Prior checkout/context: ${continuation.checkout ?? "(unknown)"} / ${continuation.contextId}`,
    continuation.checkout ? `Sanitized continuation handoff: ${continuation.checkout}/.openteam/continuation-summary.md` : "",
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
    ...results.map(result => `Prior evidence: ${result}`),
  ].filter(Boolean)
}
