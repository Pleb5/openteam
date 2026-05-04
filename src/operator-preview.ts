import {existsSync} from "node:fs"
import {mkdir} from "node:fs/promises"
import {spawnSync} from "node:child_process"
import path from "node:path"
import {prepareAgent} from "./config.js"
import {detectDevEnv} from "./dev-env.js"
import {checkDevHealthOnce, processAlive, startConfiguredDevServer, stopPid} from "./dev-server.js"
import {evaluateEvidencePolicy} from "./evidence-policy.js"
import {checkoutRuntimeEnv, writeCheckoutToolShims} from "./launcher.js"
import {holdRepoContextForOperatorPreview, isOperatorTakeoverLease, releaseOperatorPreviewContextHold} from "./repo.js"
import {readRunRecord, writeRunRecord, diagnoseRun} from "./commands/runs.js"
import {appendVerificationResultsFile, manualVerificationResult, readVerificationPlan} from "./verification.js"
import type {AppCfg, OperatorPreviewRecord, TaskRunRecord, VerificationPlan, VerificationRunnerPlan, VerificationRunnerResult} from "./types.js"

export type OperatorPreviewOptions = {
  open?: boolean
  restart?: boolean
  noHold?: boolean
}

export type OperatorPreviewRecordOptions = {
  state: Extract<VerificationRunnerResult["state"], "succeeded" | "failed" | "blocked">
  note: string
}

const now = () => new Date().toISOString()

const previewId = (runId: string) => `preview-${runId}-${Date.now().toString(36)}`

const latestPreview = (record: TaskRunRecord) => [...(record.operatorPreviews ?? [])].reverse()[0]

const appendPreview = async (record: TaskRunRecord, preview: OperatorPreviewRecord) => {
  record.operatorPreviews = [...(record.operatorPreviews ?? []), preview]
  await writeRunRecord(record)
}

const updatePreview = async (record: TaskRunRecord, id: string, patch: Partial<OperatorPreviewRecord>) => {
  record.operatorPreviews = (record.operatorPreviews ?? []).map(item => item.id === id ? {...item, ...patch} : item)
  await writeRunRecord(record)
}

const liveStoredPreview = async (record: TaskRunRecord) => {
  const preview = latestPreview(record)
  if (!preview || preview.state !== "live" || !preview.url) return undefined
  if (preview.pid && !processAlive(preview.pid)) return undefined
  const health = await checkDevHealthOnce(preview.url)
  return health.ok ? {...preview, health} : undefined
}

const liveRunPreview = async (app: AppCfg, record: TaskRunRecord): Promise<OperatorPreviewRecord | undefined> => {
  if (record.state !== "running" || record.mode !== "web") return undefined
  const diagnosis = await diagnoseRun(app, record)
  const url = record.browser?.url || record.devServer?.url || record.result?.url
  if (!url || !diagnosis.devServer.health.ok) return undefined
  const health = {
    ...diagnosis.devServer.health,
    checkedAt: new Date().toISOString(),
  }
  return {
    version: 1,
    id: previewId(record.runId),
    kind: "live-run",
    state: "live",
    requestedAt: now(),
    startedAt: record.devServer?.startedAt ?? now(),
    runId: record.runId,
    checkout: record.context?.checkout,
    contextId: record.context?.id,
    contextHeld: false,
    url,
    pid: record.devServer?.pid,
    processGroup: false,
    logFile: record.logs?.dev,
    health,
    source: "operator",
  }
}

const openUrl = (url: string) => {
  const result = spawnSync("xdg-open", [url], {stdio: "inherit"})
  if (result.status !== 0) throw new Error(`xdg-open exited with code ${result.status ?? -1}`)
}

const holdContextIfSafe = async (app: AppCfg, record: TaskRunRecord, options: OperatorPreviewOptions) => {
  const contextId = record.context?.id
  if (!contextId || options.noHold) return false
  const diagnosis = await diagnoseRun(app, record)
  if (diagnosis.context?.state === "leased") {
    if (isOperatorTakeoverLease(diagnosis.context.lease)) return false
    throw new Error(`operator preview context ${contextId} is already leased by ${diagnosis.context.lease?.workerId ?? "unknown"}/${diagnosis.context.lease?.jobId ?? "unknown"}`)
  }
  await holdRepoContextForOperatorPreview(app, contextId, record.runId)
  return true
}

export const startOperatorPreview = async (app: AppCfg, runId: string, options: OperatorPreviewOptions = {}) => {
  let record = await readRunRecord(app, runId)
  if (record.mode !== "web") throw new Error(`operator preview phase one only supports web runs; run ${runId} mode is ${record.mode ?? "unset"}`)

  if (options.restart) {
    await stopOperatorPreview(app, runId).catch(() => undefined)
    record = await readRunRecord(app, runId)
  } else {
    const stored = await liveStoredPreview(record)
    if (stored) {
      if (options.open && stored.url) openUrl(stored.url)
      return operatorPreviewView({...record, operatorPreviews: [...(record.operatorPreviews ?? []).slice(0, -1), stored]}, stored)
    }
    const live = await liveRunPreview(app, record)
    if (live) {
      await appendPreview(record, live)
      if (options.open && live.url) openUrl(live.url)
      return operatorPreviewView(record, live)
    }
  }

  const checkout = record.context?.checkout
  if (!checkout) throw new Error(`run ${runId} has no checkout for operator preview`)
  if (!existsSync(checkout)) throw new Error(`run ${runId} checkout is missing: ${checkout}`)
  if (record.state === "running") throw new Error("cannot start a separate local preview while the managed web run is still running; use the live run URL")

  const agent = await prepareAgent(app, record.baseAgentId || record.agentId, {runtimeId: record.agentId})
  const id = previewId(runId)
  const preview: OperatorPreviewRecord = {
    version: 1,
    id,
    kind: "local-dev-server",
    state: "starting",
    requestedAt: now(),
    runId,
    checkout,
    contextId: record.context?.id,
    source: "operator",
  }
  await appendPreview(record, preview)

  let contextHeld = false
  try {
    contextHeld = await holdContextIfSafe(app, record, options)
    const devEnv = record.devEnv ?? await detectDevEnv(checkout)
    await writeCheckoutToolShims(checkout, devEnv, app.root)
    const logFile = path.join(checkout, ".openteam", "artifacts", "preview", `${id}.log`)
    await mkdir(path.dirname(logFile), {recursive: true})
    const started = await startConfiguredDevServer({
      repo: agent.repo,
      portStart: agent.agent.portStart,
      label: `${agent.id}-preview`,
      taskId: id,
      checkout,
      logFile,
      env: checkoutRuntimeEnv(checkout),
      devEnv,
      detached: true,
      mirrorOutput: false,
    })
    const health = await checkDevHealthOnce(started.url)
    record = await readRunRecord(app, runId)
    await updatePreview(record, id, {
      state: "live",
      startedAt: now(),
      contextHeld,
      url: started.url,
      pid: started.child.pid,
      processGroup: started.processGroup,
      logFile: started.logFile,
      command: started.command,
      health,
    })
    record = await readRunRecord(app, runId)
    const current = record.operatorPreviews?.find(item => item.id === id) ?? preview
    if (options.open && current.url) openUrl(current.url)
    return operatorPreviewView(record, current)
  } catch (error) {
    record = await readRunRecord(app, runId).catch(() => record)
    const released = contextHeld
      ? await releaseOperatorPreviewContextHold(app, record.context?.id, runId).catch(() => false)
      : false
    await updatePreview(record, id, {
      state: "failed",
      failedAt: now(),
      contextHeld: released ? false : contextHeld,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined)
    throw error
  }
}

export const stopOperatorPreview = async (app: AppCfg, runId: string) => {
  const record = await readRunRecord(app, runId)
  const preview = latestPreview(record)
  if (!preview) throw new Error(`run ${runId} has no operator preview`)
  const ownsProcess = preview.kind === "local-dev-server"
  const stopped = ownsProcess && preview.pid ? await stopPid(preview.pid, Boolean(preview.processGroup)) : false
  const released = preview.contextHeld ? await releaseOperatorPreviewContextHold(app, preview.contextId ?? record.context?.id, runId) : false
  await updatePreview(record, preview.id, {
    state: "stopped",
    stoppedAt: now(),
    contextHeld: released ? false : preview.contextHeld,
  })
  return {runId, previewId: preview.id, stopped, releasedContext: released ? (preview.contextId ?? record.context?.id) : undefined}
}

const operatorRunner = (plan: VerificationPlan): VerificationRunnerPlan =>
  plan.runners.find(item => item.id === "operator-preview") ?? {
    id: "operator-preview",
    kind: "playwright-mcp",
    enabled: true,
    configured: true,
    local: true,
    reason: "operator preview browser evidence",
    modes: [plan.mode],
    stacks: [],
  }

export const recordOperatorPreviewEvidence = async (app: AppCfg, runId: string, options: OperatorPreviewRecordOptions) => {
  if (!options.note.trim()) throw new Error("operator preview evidence requires --note")
  const record = await readRunRecord(app, runId)
  const checkout = record.context?.checkout
  if (!checkout) throw new Error(`run ${runId} has no checkout for operator preview evidence`)
  const plan = await readVerificationPlan(checkout) ?? record.verification?.plan
  if (!plan) throw new Error(`run ${runId} has no verification plan for operator preview evidence`)
  const preview = latestPreview(record)
  const url = preview?.url
  const result = manualVerificationResult(operatorRunner(plan), {
    state: options.state,
    note: options.note,
    source: "operator",
    evidenceType: "browser",
    url,
    urlHealth: url ? await checkDevHealthOnce(url) : undefined,
    error: options.state === "failed" ? options.note : undefined,
    blocker: options.state === "blocked" ? options.note : undefined,
  })
  await appendVerificationResultsFile(checkout, [result])
  const nextResults = [...(record.verification?.results ?? []), result]
  record.verification = record.verification
    ? {...record.verification, results: nextResults}
    : {plan, results: nextResults}
  const policy = evaluateEvidencePolicy(record.doneContract, nextResults)
  if (options.state === "failed" || options.state === "blocked") {
    record.verificationState = "failed"
    record.failureCategory = options.state === "blocked" ? "operator-preview-blocked" : "operator-preview-failed"
  } else if (record.state === "needs-review" && policy.finalStateForSuccessfulWorker === "succeeded") {
    record.state = "succeeded"
    record.verificationState = "succeeded"
    record.failureCategory = undefined
  } else if (policy.level === "strong") {
    record.verificationState = "succeeded"
  }
  await writeRunRecord(record)
  return {runId, result, evidence: policy}
}

export const operatorPreviewView = (record: TaskRunRecord, preview: OperatorPreviewRecord = latestPreview(record)!) => ({
  runId: record.runId,
  preview,
  commands: {
    open: preview?.url ? `xdg-open ${preview.url}` : undefined,
    recordSucceeded: `openteam runs preview-record ${record.runId} --state succeeded --note "<what you verified>"`,
    stop: `openteam runs preview-stop ${record.runId}`,
  },
})

export const formatOperatorPreview = (view: ReturnType<typeof operatorPreviewView>) => [
  `run: ${view.runId}`,
  `preview: ${view.preview.id} ${view.preview.kind} ${view.preview.state}`,
  view.preview.url ? `url: ${view.preview.url}` : undefined,
  view.preview.pid ? `pid: ${view.preview.pid}` : undefined,
  view.preview.logFile ? `log: ${view.preview.logFile}` : undefined,
  `context held: ${view.preview.contextHeld ? "yes" : "no"}`,
  view.commands.recordSucceeded ? `record evidence: ${view.commands.recordSucceeded}` : undefined,
  `stop preview: ${view.commands.stop}`,
].filter(Boolean).join("\n")
