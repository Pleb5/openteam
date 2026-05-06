import {existsSync} from "node:fs"
import {mkdir, readFile, writeFile} from "node:fs/promises"
import {spawnSync} from "node:child_process"
import path from "node:path"
import {
  compactDiagnosis,
  diagnoseRun,
  readRunRecord,
  runEvidenceView,
  stopRunRecord,
  writeRunRecord,
} from "./commands/runs.js"
import {redactSensitiveText} from "./log-redaction.js"
import {
  holdRepoContextForOperator,
  isOperatorTakeoverLease,
  releaseOperatorRepoContextHold,
  releaseRepoContext,
} from "./repo.js"
import {resolveContinuationLineage} from "./run-continuation.js"
import type {AppCfg, TaskRunRecord, TaskState} from "./types.js"

export type OperatorTakeoverOptions = {
  reason?: string
  dryRun?: boolean
  noStop?: boolean
  noHold?: boolean
}

const nowIso = () => new Date().toISOString()

const oneLine = (value?: string) => (value ?? "").replace(/\s+/g, " ").trim()

const truncate = (value: string | undefined, max = 500) => {
  const line = oneLine(value)
  return line.length > max ? `${line.slice(0, Math.max(0, max - 3))}...` : line
}

const tailLines = (text: string, count: number) => text.split(/\r?\n/).slice(-count).join("\n").trim()

const shellQuote = (value: string) => /^[A-Za-z0-9_./:=+-]+$/.test(value)
  ? value
  : `'${value.replace(/'/g, `'"'"'`)}'`

const commandText = (command: string[]) => command.map(shellQuote).join(" ")

export const operatorTakeoverHandoffPath = (checkout: string) =>
  path.join(checkout, ".openteam", "operator-takeover.md")

const opencodeCommand = (app: AppCfg, checkout: string) => [app.config.opencode.binary || "opencode", "--dir", checkout]

const operatorTakeoverTerminalWarning = "Run the suggested command only from a real human terminal. Do not execute it from OpenCode Bash, an openteam worker, or any managed/non-interactive automation session."

const runGit = (checkout: string, args: string[]) => {
  if (!existsSync(path.join(checkout, ".git"))) return undefined
  const result = spawnSync("git", args, {cwd: checkout, encoding: "utf8", maxBuffer: 1024 * 1024})
  if (result.status !== 0) return undefined
  return result.stdout.trim()
}

const changedFiles = (status: string | undefined) =>
  (status ?? "")
    .split(/\r?\n/)
    .map(line => line.slice(3).trim())
    .filter(Boolean)
    .slice(0, 30)

const readSanitizedLogTail = async (file?: string, lines = 100) => {
  if (!file || !existsSync(file)) return ""
  const text = await readFile(file, "utf8").catch(() => "")
  return tailLines(redactSensitiveText(text), lines)
}

const readPriorRun = async (file?: string) => {
  if (!file || !existsSync(file)) return undefined
  try {
    return JSON.parse(await readFile(file, "utf8")) as TaskRunRecord
  } catch {
    return undefined
  }
}

const continuationAncestryLines = async (record: TaskRunRecord) => {
  const lines: string[] = []
  let current: TaskRunRecord | undefined = record
  const seen = new Set<string>()
  for (let depth = 0; current?.continuation && depth < 10; depth += 1) {
    const continuation = current.continuation
    lines.push(`- ${current.runId} continued ${continuation.fromRunId} (${continuation.kind}, prior ${continuation.priorState})`)
    if (!continuation.fromRunFile || seen.has(continuation.fromRunFile)) break
    seen.add(continuation.fromRunFile)
    current = await readPriorRun(continuation.fromRunFile)
  }
  return lines
}

const phaseSummary = (record: TaskRunRecord) => {
  const phases = record.phases.slice(-12)
  return phases.length > 0
    ? phases.map(phase => `- ${phase.name}: ${phase.state}${phase.error ? ` (${truncate(phase.error, 180)})` : ""}`)
    : ["- no phases recorded"]
}

const finalResponseLines = (record: TaskRunRecord) => {
  const text = record.finalResponse?.text ?? record.result?.finalResponse?.text
  if (!text) return ["- no final response captured"]
  return [`- ${truncate(redactSensitiveText(text), 900)}`]
}

export const buildOperatorTakeoverHandoff = async (
  app: AppCfg,
  record: TaskRunRecord,
  options: {
    reason?: string
    command?: string[]
    diagnosis?: Awaited<ReturnType<typeof diagnoseRun>>
  } = {},
) => {
  const checkout = record.context?.checkout
  if (!checkout) throw new Error(`run ${record.runId} has no checkout for operator takeover`)
  const diagnosis = options.diagnosis ?? await diagnoseRun(app, record)
  const compact = compactDiagnosis(diagnosis)
  const evidence = runEvidenceView(record)
  const status = runGit(checkout, ["status", "--short"])
  const diffStat = runGit(checkout, ["diff", "--stat", "HEAD"]) ?? runGit(checkout, ["diff", "--stat"])
  const branch = runGit(checkout, ["branch", "--show-current"]) || record.context?.branch
  const files = changedFiles(status)
  const logTail = await readSanitizedLogTail(record.logs?.opencode)
  const ancestry = await continuationAncestryLines(record)
  const lineage = await resolveContinuationLineage(record).catch(() => [record])
  const root = lineage[0] ?? record
  const command = options.command ?? opencodeCommand(app, checkout)

  return `${[
    "# Operator Takeover",
    "",
    "Automation has been interrupted or set aside for manual steering. Use normal operator-controlled OpenCode mode, not an openteam worker agent, unless you intentionally choose otherwise.",
    "",
    "## Prior Discussion Summary",
    `- prior run: ${record.runId}`,
    `- original run: ${record.continuation?.originRunId ?? root.runId}`,
    `- original task: ${redactSensitiveText(record.continuation?.originTask ?? root.task)}`,
    record.continuation?.priorTask ? `- immediate prior task: ${redactSensitiveText(record.continuation.priorTask)}` : "",
    `- worker role/mode: ${record.role}${record.mode ? `/${record.mode}` : ""}`,
    `- target: ${record.target ?? "(unset)"}`,
    `- prior state: ${record.state}`,
    record.workerState ? `- prior worker state: ${record.workerState}` : "",
    record.verificationState ? `- prior verification state: ${record.verificationState}` : "",
    record.failureCategory ? `- prior failure category: ${record.failureCategory}` : "",
    options.reason ? `- operator takeover reason: ${redactSensitiveText(options.reason)}` : "",
    compact?.opencodeProgress.blocked ? `- observed OpenCode blocker: ${compact.opencodeProgress.blocked.kind} - ${redactSensitiveText(compact.opencodeProgress.blocked.reason)} (${redactSensitiveText(compact.opencodeProgress.blocked.evidence)})` : "",
    compact?.opencodeProgress.stallSeverity ? `- observed OpenCode stall: ${compact.opencodeProgress.stallSeverity}, idle ${Math.round((compact.opencodeProgress.logAgeMs ?? 0) / 60_000)}m` : "",
    compact?.reasons.length ? `- diagnosis: ${redactSensitiveText(compact.reasons.join("; "))}` : "",
    ancestry.length > 0 ? "- continuation ancestry:" : "- continuation ancestry: none recorded",
    ...ancestry,
    "",
    "## Current Repo State",
    `- checkout: ${checkout}`,
    `- branch: ${branch ?? "(unknown)"}`,
    `- context: ${record.context?.id ?? "(none)"}`,
    `- git status: ${status ? "changes present" : "clean or unavailable"}`,
    files.length > 0 ? `- changed files: ${files.join(", ")}` : "- changed files: none detected",
    diffStat ? `- diff stat: ${redactSensitiveText(diffStat.replace(/\r?\n/g, "; "))}` : "",
    "",
    "## Completed Or Active Phases",
    ...phaseSummary(record),
    "",
    "## Prior Final Response",
    ...finalResponseLines(record),
    "",
    "## Evidence And Publication State",
    `- evidence level: ${evidence.level}`,
    `- PR eligible: ${evidence.prEligible ? "yes" : "no"}`,
    `- recommended action: ${evidence.recommendedAction}`,
    evidence.missingEvidence.length > 0 ? `- missing evidence: ${evidence.missingEvidence.join("; ")}` : "- missing evidence: none reported",
    evidence.prBlockers.length > 0 ? `- PR blockers: ${evidence.prBlockers.join("; ")}` : "- PR blockers: none reported",
    evidence.results.length > 0 ? `- verification results: ${evidence.results.map(result => `${result.id}:${result.state}`).join(", ")}` : "- verification results: none recorded",
    "",
    "## Useful Files",
    record.taskManifestPath ? `- task manifest: ${record.taskManifestPath}` : "- task manifest: .openteam/task.json if present",
    "- verification results: .openteam/verification-results.json if present",
    `- prior run record: ${record.runFile}`,
    record.logs?.opencode ? `- prior OpenCode log: ${record.logs.opencode}` : "- prior OpenCode log: (none)",
    "",
    "## Suggested Manual Start Prompt",
    "Start by reading this takeover handoff and .openteam/task.json. Continue manually from the current checkout state, verify any claims before publishing, and use openteam verify/openteam repo helpers only when useful.",
    "",
    "## Suggested Command",
    operatorTakeoverTerminalWarning,
    "",
    "```sh",
    commandText(command),
    "```",
    logTail ? "" : "",
    logTail ? "## Sanitized Prior Transcript Tail" : "",
    logTail ? "" : "",
    logTail,
  ].filter(Boolean).join("\n")}
`
}

export const planOperatorTakeover = async (
  app: AppCfg,
  record: TaskRunRecord,
  options: OperatorTakeoverOptions = {},
) => {
  const checkout = record.context?.checkout
  if (!checkout) throw new Error(`run ${record.runId} has no checkout for operator takeover`)
  if (!existsSync(checkout)) throw new Error(`run ${record.runId} checkout is missing: ${checkout}`)
  if (record.state === "running" && options.noStop) {
    throw new Error("operator takeover of a running managed worker requires stopping automation first")
  }
  const diagnosis = await diagnoseRun(app, record)
  const contextId = record.context?.id
  const willHoldContext = Boolean(contextId && !options.noHold)
  if (
    willHoldContext &&
    diagnosis.context?.state === "leased" &&
    !diagnosis.context.leaseMatchesRun &&
    !isOperatorTakeoverLease(diagnosis.context.lease)
  ) {
    throw new Error(`operator takeover context ${contextId} is already leased by ${diagnosis.context.lease?.workerId ?? "unknown"}/${diagnosis.context.lease?.jobId ?? "unknown"}`)
  }

  const command = opencodeCommand(app, checkout)
  return {
    runId: record.runId,
    state: record.state,
    checkout,
    contextId,
    handoffFile: operatorTakeoverHandoffPath(checkout),
    command,
    commandText: commandText(command),
    shouldStopManagedWorker: record.state === "running",
    willHoldContext,
    diagnosis: compactDiagnosis(diagnosis),
  }
}

export const executeOperatorTakeover = async (
  app: AppCfg,
  runId: string,
  options: OperatorTakeoverOptions = {},
) => {
  const original = await readRunRecord(app, runId)
  const plan = await planOperatorTakeover(app, original, options)
  if (options.dryRun) {
    return {...plan, dryRun: true, handoffWritten: false, contextHeld: false, stoppedManagedWorker: false}
  }

  let record = original
  let stoppedManagedWorker = false
  let releasedPriorLease = false

  if (original.state === "running") {
    const stopped = await stopRunRecord(app, original.runId, "interrupted")
    stoppedManagedWorker = true
    releasedPriorLease = Boolean(stopped.releasedContext)
    record = await readRunRecord(app, original.runId)
  } else if (plan.willHoldContext && original.context?.id) {
    const released = await releaseRepoContext(app, original.context.id, {workerId: original.agentId, jobId: original.taskId})
    releasedPriorLease = releasedPriorLease || released
  }

  let contextHeld = false
  if (plan.willHoldContext && original.context?.id) {
    await holdRepoContextForOperator(app, original.context.id, original.runId)
    contextHeld = true
  }

  const handoffText = await buildOperatorTakeoverHandoff(app, original, {
    reason: options.reason,
    command: plan.command,
    diagnosis: await diagnoseRun(app, original).catch(() => undefined),
  })
  await mkdir(path.dirname(plan.handoffFile), {recursive: true})
  await writeFile(plan.handoffFile, handoffText)

  record = await readRunRecord(app, original.runId)
  if (original.state === "running") {
    record.state = "interrupted"
    record.failureCategory = "operator-takeover"
    record.error = "run handed to operator for manual takeover"
  }
  record.manualTakeover = {
    version: 1,
    requestedAt: nowIso(),
    previousState: original.state as TaskState,
    reason: options.reason,
    handoffFile: plan.handoffFile,
    contextId: original.context?.id,
    contextHeld,
    stoppedManagedWorker,
    releasedPriorLease,
    command: plan.command,
  }
  await writeRunRecord(record)

  return {
    ...plan,
    dryRun: false,
    handoffWritten: true,
    contextHeld,
    stoppedManagedWorker,
    releasedPriorLease,
  }
}

export const releaseOperatorTakeover = async (app: AppCfg, runId: string) => {
  const record = await readRunRecord(app, runId)
  if (!record.manualTakeover) throw new Error(`run ${runId} has no manual takeover record`)
  const contextId = record.manualTakeover.contextId ?? record.context?.id
  const released = await releaseOperatorRepoContextHold(app, contextId, runId)
  record.manualTakeover = {
    ...record.manualTakeover,
    releasedAt: nowIso(),
    contextHeld: released ? false : record.manualTakeover.contextHeld,
  }
  await writeRunRecord(record)
  return {runId, contextId, released}
}

export const formatOperatorTakeoverResult = (result: Awaited<ReturnType<typeof executeOperatorTakeover>>) => [
  result.dryRun ? "manual takeover dry run" : "manual takeover ready",
  `run: ${result.runId}`,
  `handoff: ${result.handoffFile}`,
  `context held: ${result.contextHeld ? "yes" : result.willHoldContext ? "planned" : "no"}`,
  `stopped managed worker: ${result.stoppedManagedWorker ? "yes" : result.shouldStopManagedWorker ? "planned" : "no"}`,
  `warning: ${operatorTakeoverTerminalWarning}`,
  `command: ${result.commandText}`,
].join("\n")
