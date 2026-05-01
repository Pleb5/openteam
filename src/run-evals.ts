import {evaluateEvidencePolicy, type EvidenceLevel} from "./evidence-policy.js"
import {scoreRoleFinalResponse} from "./eval-fixtures.js"
import {roleOutputContractLabels} from "./role-contracts.js"
import type {TaskRunRecord, TaskState} from "./types.js"

export type RunEvalSeverity = "failure" | "warning" | "info"

export type RunEvalFinding = {
  code: string
  severity: RunEvalSeverity
  message: string
  details?: Record<string, unknown>
}

export type RunEvalOptions = {
  finalResponseText?: string
}

export type RunEvalResult = {
  version: 1
  runId: string
  role: string
  mode?: string
  state: TaskState
  terminal: boolean
  ok: boolean
  score: number
  evidenceLevel: EvidenceLevel
  prEligible: boolean
  finalStateForSuccessfulWorker: "succeeded" | "needs-review"
  missingEvidence: string[]
  prBlockers: string[]
  finalResponse?: {
    available: boolean
    source?: string
    presentLabels: string[]
    missingLabels: string[]
  }
  findings: RunEvalFinding[]
  failures: RunEvalFinding[]
  warnings: RunEvalFinding[]
}

const terminalStates = new Set<TaskState>(["succeeded", "needs-review", "failed", "interrupted", "stale"])

const finding = (
  severity: RunEvalSeverity,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): RunEvalFinding => ({code, severity, message, details})

const clampScore = (score: number) => Math.max(0, Math.min(100, Math.round(score)))

const hasFailedOrBlockedVerification = (record: TaskRunRecord) =>
  (record.verification?.results ?? []).some(result => result.state === "failed" || result.state === "blocked")

const hasTerminalDiagnostic = (record: TaskRunRecord) =>
  Boolean(
    record.error ||
    record.failureCategory ||
    record.provisionFailureCategory ||
    hasFailedOrBlockedVerification(record),
  )

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const labelLinePattern = (labels: string[]) => {
  if (labels.length === 0) return undefined
  return new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?(${labels.map(escapeRegExp).join("|")})\\s*:(?:\\*\\*)?\\s*(.*)$`, "i")
}

const extractLabelSection = (role: string, text: string, label: string) => {
  const labels = roleOutputContractLabels(role)
  const pattern = labelLinePattern(labels)
  if (!pattern) return undefined

  let capturing = false
  const lines: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(pattern)
    if (match) {
      if (capturing) break
      capturing = match[1].toLowerCase() === label.toLowerCase()
      if (capturing) lines.push(match[2] ?? "")
      continue
    }
    if (capturing) lines.push(line)
  }

  if (!capturing) return undefined
  return lines.join("\n").trim()
}

const hasNormalPrClaim = (role: string, text: string) => {
  const publicationReadiness = extractLabelSection(role, text, "Publication Readiness")
  return Boolean(
    publicationReadiness && /\bPR eligible\b/i.test(publicationReadiness),
  ) || /\b(published|opened|created)\b.{0,80}\b(PR|pull request|Nostr-git PR)\b/i.test(text)
}

const isNoHandoff = (value: string) => /^no handoff\b/i.test(value.trim())

const scoreFinalResponse = (
  record: TaskRunRecord,
  input: {text?: string; source?: string},
  policy: ReturnType<typeof evaluateEvidencePolicy>,
  findings: RunEvalFinding[],
): RunEvalResult["finalResponse"] => {
  const finalText = input.text?.trim()
  if (!finalText) {
    findings.push(finding(
      "warning",
      "final-response-unavailable",
      "run record does not include final worker response text to score role output labels",
    ))
    return {
      available: false,
      source: input.source,
      presentLabels: [],
      missingLabels: roleOutputContractLabels(record.role),
    }
  }

  const score = scoreRoleFinalResponse(record.role, finalText)
  if (score.missingLabels.length > 0) {
    findings.push(finding(
      "failure",
      "final-response-contract-missing-labels",
      "final worker response is missing required role output labels",
      {missingLabels: score.missingLabels},
    ))
  }

  const evidenceClaim = extractLabelSection(record.role, finalText, "Evidence Level")
  if (evidenceClaim && /\bstrong\b/i.test(evidenceClaim) && policy.level !== "strong") {
    findings.push(finding(
      "failure",
      "final-response-overclaims-evidence",
      "final worker response claims strong evidence but the recorded evidence policy does not",
      {claimed: evidenceClaim, actual: policy.level},
    ))
  }

  if (hasNormalPrClaim(record.role, finalText) && !policy.prEligible) {
    findings.push(finding(
      "failure",
      "final-response-overclaims-publication-readiness",
      "final worker response claims normal PR readiness or publication while policy blocks it",
      {prBlockers: policy.prBlockers},
    ))
  }

  const blockers = extractLabelSection(record.role, finalText, "Blockers")
  if (
    blockers &&
    /^none\b/i.test(blockers) &&
    (record.state === "failed" || record.state === "interrupted" || record.state === "stale" || policy.level === "failed" || policy.level === "blocked")
  ) {
    findings.push(finding(
      "warning",
      "final-response-understates-blockers",
      "final worker response says there are no blockers despite terminal failure or blocked evidence",
      {state: record.state, evidenceLevel: policy.level},
    ))
  }

  if (record.role === "researcher" || record.role === "triager" || record.role === "qa") {
    const handoff = extractLabelSection(record.role, finalText, "Handoff")
    if (handoff && !isNoHandoff(handoff)) {
      if (handoff.length < 16) {
        findings.push(finding(
          "warning",
          "handoff-too-thin",
          "handoff is present but too short to be reliably actionable",
          {handoff},
        ))
      }
      if (!/\b(builder|qa|researcher|triager|operator)\b/i.test(handoff)) {
        findings.push(finding(
          "warning",
          "handoff-missing-recipient-role",
          "handoff does not name the next worker role or operator",
          {handoff},
        ))
      }
    }
  }

  if (record.role === "qa") {
    const verdict = extractLabelSection(record.role, finalText, "Verdict")
    if (verdict && !/\b(ship|do not ship|needs builder|needs researcher|needs operator input)\b/i.test(verdict)) {
      findings.push(finding(
        "warning",
        "qa-verdict-unknown",
        "QA verdict does not use known verdict vocabulary",
        {verdict},
      ))
    }
  }

  if (record.role === "triager") {
    const route = extractLabelSection(record.role, finalText, "Route")
    if (route && !/\b(builder|qa|researcher|operator|no action|needs-info)\b/i.test(route)) {
      findings.push(finding(
        "warning",
        "triage-route-unknown",
        "triage route does not use known routing vocabulary",
        {route},
      ))
    }
  }

  return {
    available: true,
    source: input.source,
    presentLabels: score.presentLabels,
    missingLabels: score.missingLabels,
  }
}

export const evaluateRunRecord = (
  record: TaskRunRecord,
  options: RunEvalOptions = {},
): RunEvalResult => {
  const policy = evaluateEvidencePolicy(record.doneContract, record.verification?.results ?? [])
  const findings: RunEvalFinding[] = []
  const terminal = terminalStates.has(record.state)

  if (!terminal) {
    findings.push(finding(
      "info",
      "active-run-skipped",
      "run is not terminal; offline run-record eval is skipped for active records",
      {state: record.state},
    ))
  }

  if (terminal && record.state === "succeeded" && policy.finalStateForSuccessfulWorker !== "succeeded") {
    findings.push(finding(
      "failure",
      "succeeded-without-strong-evidence",
      "run is marked succeeded but recorded evidence is not strong enough for a successful worker state",
      {evidenceLevel: policy.level, missingEvidence: policy.missingEvidence},
    ))
  }

  if (terminal && record.state === "needs-review" && policy.level !== "strong") {
    findings.push(finding(
      "warning",
      "needs-review-with-incomplete-evidence",
      "run correctly remains needs-review because evidence is missing, weak, blocked, or failed",
      {evidenceLevel: policy.level, missingEvidence: policy.missingEvidence},
    ))
  }

  if (terminal && record.state === "needs-review" && policy.level === "strong" && !record.failureCategory) {
    findings.push(finding(
      "warning",
      "needs-review-with-strong-evidence",
      "run has strong evidence but is still marked needs-review without a failure category",
    ))
  }

  if (
    terminal &&
    (record.state === "failed" || record.state === "interrupted" || record.state === "stale") &&
    !hasTerminalDiagnostic(record)
  ) {
    findings.push(finding(
      "failure",
      "terminal-run-missing-diagnostic",
      "failed, interrupted, or stale run has no diagnostic error, failure category, provision category, failed verification, or blocked verification",
      {state: record.state},
    ))
  }

  if (record.result?.prEligible === true && !policy.prEligible) {
    findings.push(finding(
      "failure",
      "result-pr-eligible-mismatch",
      "run result claims PR eligibility while evidence policy blocks normal PR publication",
      {prBlockers: policy.prBlockers},
    ))
  }

  if (record.result?.evidenceLevel && record.result.evidenceLevel !== policy.level) {
    findings.push(finding(
      "warning",
      "result-evidence-level-mismatch",
      "run result evidence level differs from recomputed evidence policy",
      {resultEvidenceLevel: record.result.evidenceLevel, actualEvidenceLevel: policy.level},
    ))
  }

  if (record.result?.state && record.result.state !== record.state) {
    findings.push(finding(
      "warning",
      "result-state-mismatch",
      "run result state differs from the stored run state",
      {resultState: record.result.state, recordState: record.state},
    ))
  }

  const responseText = options.finalResponseText ?? record.finalResponse?.text
  const responseSource = options.finalResponseText !== undefined ? "operator-file" : record.finalResponse?.source
  const finalResponse = terminal
    ? scoreFinalResponse(record, {text: responseText, source: responseSource}, policy, findings)
    : {
      available: false,
      source: responseSource,
      presentLabels: [],
      missingLabels: roleOutputContractLabels(record.role),
    }

  const failures = findings.filter(item => item.severity === "failure")
  const warnings = findings.filter(item => item.severity === "warning")
  const score = terminal
    ? clampScore(100 - failures.length * 25 - warnings.length * 8)
    : 0

  return {
    version: 1,
    runId: record.runId,
    role: record.role,
    mode: record.mode,
    state: record.state,
    terminal,
    ok: terminal && failures.length === 0,
    score,
    evidenceLevel: policy.level,
    prEligible: policy.prEligible,
    finalStateForSuccessfulWorker: policy.finalStateForSuccessfulWorker,
    missingEvidence: policy.missingEvidence,
    prBlockers: policy.prBlockers,
    finalResponse,
    findings,
    failures,
    warnings,
  }
}
