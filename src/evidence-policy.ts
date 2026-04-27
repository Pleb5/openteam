import type {DoneContract, TaskState, VerificationRunnerResult} from "./types.js"

export type EvidenceLevel = "failed" | "blocked" | "none" | "weak" | "strong"
export type EvidenceGroup = "repo-native" | "browser" | "nostr" | "desktop" | "mobile" | "manual" | "runtime"

export type EvidencePolicyView = {
  level: EvidenceLevel
  finalStateForSuccessfulWorker: Extract<TaskState, "succeeded" | "needs-review">
  prEligible: boolean
  prBlockers: string[]
  requiredEvidence: string[]
  missingEvidence: string[]
  recommendedAction: string
}

const successful = (results: VerificationRunnerResult[]) =>
  results.filter(result => result.state === "succeeded")

const reportVerdictTaskClasses = new Set<DoneContract["taskClass"]>(["qa", "research", "triage"])

export const acceptsVerificationVerdicts = (contract?: DoneContract) =>
  Boolean(contract && reportVerdictTaskClasses.has(contract.taskClass))

export const verificationFailuresBlockTask = (contract?: DoneContract) =>
  !acceptsVerificationVerdicts(contract)

const usableEvidence = (
  contract: DoneContract | undefined,
  results: VerificationRunnerResult[],
) => acceptsVerificationVerdicts(contract)
  ? results.filter(result => result.state !== "skipped")
  : successful(results)

const hasText = (result: VerificationRunnerResult, pattern: RegExp) =>
  pattern.test([
    result.id,
    result.kind,
    result.evidenceType,
    result.note,
    result.logFile,
    result.artifacts?.join(" "),
    result.screenshots?.join(" "),
    result.command?.join(" "),
    result.url,
    result.flow,
    result.consoleSummary,
    result.networkSummary,
    result.eventIds?.join(" "),
  ].filter(Boolean).join(" "))

const hasSubstantiveEvidence = (result: VerificationRunnerResult) =>
  Boolean(
    result.note?.trim() ||
    result.blocker?.trim() ||
    result.logFile?.trim() ||
    result.artifacts?.length ||
    result.screenshots?.length ||
    result.url?.trim() ||
    result.flow?.trim() ||
    result.consoleSummary?.trim() ||
    result.networkSummary?.trim() ||
    result.eventIds?.length,
  )

const hasAgenticEvidence = (results: VerificationRunnerResult[], contract?: DoneContract) =>
  usableEvidence(contract, results).some(hasSubstantiveEvidence)

const hasBrowserEvidence = (results: VerificationRunnerResult[], contract?: DoneContract) =>
  usableEvidence(contract, results).some(result =>
    result.evidenceType === "browser" ||
    result.id === "browser" ||
    result.kind === "playwright-mcp" ||
    hasText(result, /\b(browser|playwright|ui|screen|visual|page|flow)\b/i),
  )

const hasCommandEvidence = (results: VerificationRunnerResult[], contract?: DoneContract) =>
  usableEvidence(contract, results).some(result =>
    result.evidenceType === "repo-native" ||
    result.id === "repo-native" ||
    result.kind === "command" ||
    result.kind === "desktop-command" ||
    hasText(result, /\b(test|check|build|lint|clippy|cargo|pnpm|npm|bun)\b/i),
  )

const taskClass = (contract?: DoneContract) => contract?.taskClass ?? "general"

export const evidenceGroupForResult = (result: VerificationRunnerResult): EvidenceGroup => {
  if (result.evidenceType) return result.evidenceType
  if (result.id === "repo-native") return "repo-native"
  if (result.kind === "playwright-mcp" || result.id === "browser") return "browser"
  if (result.kind === "desktop-command") return "desktop"
  if (result.kind === "android-adb" || result.kind === "ios-simulator") return "mobile"
  if (result.eventIds?.length || hasText(result, /\b(nevent|naddr|nostr|relay|event id)\b/i)) return "nostr"
  if (result.source === "runtime") return "runtime"
  return "manual"
}

export const groupEvidenceResults = (results: VerificationRunnerResult[]) => {
  const groups: Record<EvidenceGroup, VerificationRunnerResult[]> = {
    "repo-native": [],
    browser: [],
    nostr: [],
    desktop: [],
    mobile: [],
    manual: [],
    runtime: [],
  }
  for (const result of results) {
    groups[evidenceGroupForResult(result)].push(result)
  }
  return groups
}

export const evidenceLevel = (
  contract: DoneContract | undefined,
  results: VerificationRunnerResult[],
): EvidenceLevel => {
  if (verificationFailuresBlockTask(contract)) {
    if (results.some(result => result.state === "failed")) return "failed"
    if (results.some(result => result.state === "blocked")) return "blocked"
  }

  const usable = usableEvidence(contract, results)
  if (usable.length === 0) return "none"

  const substantiveCount = usable.filter(hasSubstantiveEvidence).length
  const agentic = hasAgenticEvidence(results, contract)
  const command = hasCommandEvidence(results, contract)
  const browser = hasBrowserEvidence(results, contract)

  switch (taskClass(contract)) {
    case "ui-web":
      return browser && command && agentic ? "strong" : "weak"
    case "bug-fix":
    case "implementation":
      return command && agentic ? "strong" : "weak"
    case "qa":
      return agentic || browser ? "strong" : "weak"
    case "triage":
    case "research":
      return agentic ? "strong" : "weak"
    default:
      return agentic || substantiveCount >= 2 ? "strong" : "weak"
  }
}

const requirementCovered = (
  requirement: string,
  results: VerificationRunnerResult[],
  contract?: DoneContract,
) => {
  const text = requirement.toLowerCase()
  const usable = usableEvidence(contract, results)
  if (usable.length === 0) return false

  if (/\b(browser|visible|ui|gui|screen|flow)\b/.test(text)) return hasBrowserEvidence(results, contract)
  if (/\b(repo-native|command|validation|check|test|build|lint|clippy|cargo)\b/.test(text)) return hasCommandEvidence(results, contract)
  if (/\b(artifact|screenshot|session|log)\b/.test(text)) return usable.some(hasSubstantiveEvidence)
  if (/\b(repro|reproduction|reproduced)\b/.test(text)) return usable.some(result => hasText(result, /\b(repro|reproduce|reproduced|not reproducible)\b/i))
  if (/\b(verdict|expected|actual|pass|fail|flaky|blocked)\b/.test(text)) return usable.some(result => hasText(result, /\b(verdict|expected|actual|pass|fail|flaky|blocked)\b/i))
  if (/\b(pr|publication|publish|event|branch)\b/.test(text)) return usable.some(result => hasText(result, /\b(pr|publish|published|event|branch)\b/i))

  return usable.some(hasSubstantiveEvidence)
}

const missingEvidence = (
  contract: DoneContract | undefined,
  results: VerificationRunnerResult[],
  level: EvidenceLevel,
) => {
  const required = contract?.requiredEvidence ?? []
  if (level === "strong") return []
  const missing = required.filter(requirement => !requirementCovered(requirement, results, contract))
  if (missing.length > 0) return missing
  if (level === "none") return required.length > 0 ? required : ["verification evidence"]
  if (level === "weak") return ["additional task-specific verification note or artifact"]
  return []
}

const prPolicyAllowsNormalPublish = (contract?: DoneContract) =>
  !contract || !/\bdoes not publish PRs?\b/i.test(contract.prPolicy)

export const evaluateEvidencePolicy = (
  contract: DoneContract | undefined,
  results: VerificationRunnerResult[],
): EvidencePolicyView => {
  const level = evidenceLevel(contract, results)
  const missing = missingEvidence(contract, results, level)
  const failedOrBlocked = verificationFailuresBlockTask(contract) && (level === "failed" || level === "blocked")
  const prBlockers = [
    ...(!prPolicyAllowsNormalPublish(contract) ? [contract?.prPolicy ?? "role does not normally publish PRs"] : []),
    ...(failedOrBlocked ? ["verification evidence is failed or blocked"] : []),
    ...(level === "none" ? ["no successful verification evidence has been recorded"] : []),
    ...(level === "weak" ? ["verification evidence is weak; record stronger task-specific evidence before publication"] : []),
    ...missing.map(item => `missing evidence: ${item}`),
  ]
  const prEligible = prPolicyAllowsNormalPublish(contract) && level === "strong" && !results.some(result => result.state === "failed" || result.state === "blocked")
  const finalStateForSuccessfulWorker = level === "strong" ? "succeeded" : "needs-review"

  return {
    level,
    finalStateForSuccessfulWorker,
    prEligible,
    prBlockers: Array.from(new Set(prBlockers)),
    requiredEvidence: contract?.requiredEvidence ?? [],
    missingEvidence: missing,
    recommendedAction: level === "strong"
      ? acceptsVerificationVerdicts(contract)
        ? "report-only verdict has enough evidence for normal review; PR publication remains governed by role policy"
        : "worker result has enough evidence for normal review and PR publication when role policy allows it"
      : failedOrBlocked
        ? "do not publish a PR; inspect the verification failure or blocker and continue or relaunch the worker"
        : "continue the worker or relaunch a focused verification task before accepting the result as complete",
  }
}

export const prPublicationDecision = (
  policy: EvidencePolicyView,
  options: {draft?: boolean} = {},
) => {
  if (policy.prEligible) {
    return {allowed: true, reason: "verification evidence is strong enough for normal PR publication"}
  }
  if (options.draft) {
    return {allowed: true, reason: "draft/WIP PR publication explicitly requested despite incomplete verification evidence"}
  }
  return {
    allowed: false,
    reason: policy.prBlockers[0] ?? "verification evidence is not strong enough for PR publication",
  }
}
