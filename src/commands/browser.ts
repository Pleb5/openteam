import {existsSync} from "node:fs"
import {spawnSync} from "node:child_process"
import path from "node:path"
import {prepareAgent} from "../config.js"
import {listWorkers} from "../supervisor.js"
import type {AgentRuntimeState, AppCfg} from "../types.js"
import {checkUrl, compactDiagnosis, diagnoseRun, readJsonFile, readRunRecord} from "./runs.js"

const flag = (args: string[], key: string) => args.includes(key)

const must = (value: string, label: string) => {
  if (!value) throw new Error(`missing ${label}`)
  return value
}

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`

const agentIdForRef = (app: AppCfg, value?: string, fallback = "") => {
  const raw = value || fallback
  if (!raw) throw new Error("missing agentId or role")
  if (app.config.agents[raw]) return raw
  const match = Object.keys(app.config.agents).find(id => app.config.agents[id]?.role === raw)
  if (match) return match
  throw new Error(`unknown agent or role: ${raw}`)
}

const resolveBrowserAgent = async (app: AppCfg, ref: string) => {
  const workers = await listWorkers(app)
  const byWorker = workers.find(worker => worker.name === ref || worker.runtimeId === ref)
  if (byWorker) {
    return {
      ref,
      agentId: byWorker.agentId,
      runtimeId: byWorker.runtimeId ?? byWorker.agentId,
      workerName: byWorker.name,
    }
  }

  const roleMatches = workers.filter(worker => worker.role === ref && worker.running)
  if (roleMatches.length === 1) {
    const match = roleMatches[0]
    return {
      ref,
      agentId: match.agentId,
      runtimeId: match.runtimeId ?? match.agentId,
      workerName: match.name,
    }
  }
  if (roleMatches.length > 1) {
    throw new Error(`multiple live ${ref} jobs found; use one of: ${roleMatches.map(worker => worker.name).join(", ")}`)
  }

  const agentId = agentIdForRef(app, ref)
  return {ref, agentId, runtimeId: agentId, workerName: undefined}
}

export const browserInspection = async (app: AppCfg, ref: string) => {
  const resolved = await resolveBrowserAgent(app, ref)
  const agent = await prepareAgent(app, resolved.agentId, {runtimeId: resolved.runtimeId})
  const state = existsSync(agent.paths.stateFile)
    ? await readJsonFile<AgentRuntimeState>(agent.paths.stateFile)
    : {}
  const browserProfile = state.browserProfile ?? path.join(agent.paths.browser, "profile")
  const browserArtifacts = state.browserArtifacts ?? path.join(agent.paths.artifacts, "playwright")
  const url = state.url ?? ""
  const runRecord = state.runId
    ? await readRunRecord(app, state.runId).catch(() => undefined)
    : undefined
  const diagnosis = runRecord
    ? await diagnoseRun(app, runRecord).catch(() => undefined)
    : undefined
  const devHealth = diagnosis?.devServer.health ?? await checkUrl(url)
  const stale = Boolean(diagnosis?.stale)
  const runState = runRecord
    ? runRecord.state === "succeeded" && (
      diagnosis?.hardFailure ||
      runRecord.workerState === "failed" ||
      runRecord.verificationState === "failed"
    )
      ? "failed"
      : stale
        ? "stale"
        : runRecord.state
    : state.state
  const storedRunning = Boolean(state.running)
  const effectiveRunning = Boolean(storedRunning && !stale)
  const liveWebRun = Boolean(effectiveRunning && state.mode === "web" && url && devHealth.ok)
  return {
    agentId: agent.id,
    baseAgentId: agent.configId,
    runtimeId: agent.id,
    workerName: resolved.workerName,
    role: agent.agent.role,
    running: effectiveRunning,
    storedRunning,
    stale,
    staleReasons: diagnosis?.reasons,
    runDiagnosis: compactDiagnosis(diagnosis),
    runState,
    storedRunState: runRecord?.state && runState !== runRecord.state ? runRecord.state : undefined,
    workerState: runRecord?.workerState,
    verificationState: runRecord?.verificationState,
    failureCategory: runRecord?.failureCategory,
    finishedAt: runRecord?.finishedAt ?? state.finishedAt,
    liveWebRun,
    devServer: {
      url,
      health: devHealth,
      stoppedAt: runRecord?.devServer?.stoppedAt,
      lastHealthCheckAt: runRecord?.devServer?.lastHealthCheckAt,
      lastHealthOkAt: runRecord?.devServer?.lastHealthOkAt,
      firstHealthFailureAt: runRecord?.devServer?.firstHealthFailureAt,
      healthChecks: runRecord?.devServer?.healthChecks,
      healthFailures: runRecord?.devServer?.healthFailures,
      exitCode: runRecord?.devServer?.exitCode,
      exitSignal: runRecord?.devServer?.exitSignal,
      restartCount: runRecord?.devServer?.restartCount,
      restartedAt: runRecord?.devServer?.restartedAt,
      restartLog: runRecord?.devServer?.restartLog,
    },
    taskId: state.taskId,
    target: state.target,
    mode: state.mode,
    devEnv: runRecord?.devEnv?.kind ?? state.devEnv,
    devEnvSource: runRecord?.devEnv?.source ?? state.devEnvSource,
    projectProfile: runRecord?.projectProfile?.path ?? state.projectProfile,
    projectStacks: runRecord?.projectProfile?.stacks ?? state.projectStacks,
    verificationPlan: runRecord?.verification?.planPath ?? state.verificationPlan,
    verificationRunners: runRecord?.verification?.plan.runners.map(runner => `${runner.id}:${runner.configured ? "configured" : "unavailable"}`) ?? state.verificationRunners,
    verificationResults: runRecord?.verification?.results?.map(result => `${result.id}:${result.state}`),
    url,
    checkout: state.checkout,
    logFile: state.logFile,
    runId: state.runId,
    runFile: state.runFile,
    durationMs: state.durationMs,
    browserHeadless: state.browserHeadless ?? app.config.browser.headless,
    browserProfile,
    browserArtifacts,
    browserExecutable: app.config.browser.executablePath || "chromium",
    commands: {
      openUrl: liveWebRun ? `xdg-open ${url}` : undefined,
      tailLog: state.logFile ? `tail -f ${state.logFile}` : undefined,
      recordBrowserEvidence: state.checkout && url ? `cd ${shellQuote(state.checkout)} && openteam verify browser --flow "<flow>" --url ${shellQuote(url)} --dev-health --note "<what was verified>" --screenshot <path>` : undefined,
      openProfileAfterRun: `${app.config.browser.executablePath || "chromium"} --user-data-dir ${browserProfile}`,
    },
  }
}

const printBrowserInspection = (info: Awaited<ReturnType<typeof browserInspection>>) => {
  console.log(`agent: ${info.agentId}`)
  console.log(`base agent: ${info.baseAgentId}`)
  console.log(`runtime id: ${info.runtimeId}`)
  console.log(`worker: ${info.workerName ?? "(none)"}`)
  console.log(`role: ${info.role}`)
  console.log(`running: ${info.running ? "yes" : "no"}${info.storedRunning && !info.running ? " (stored running, diagnosed stale)" : ""}`)
  console.log(`run state: ${info.runState ?? "(none)"}${info.storedRunState ? ` (stored ${info.storedRunState})` : ""}`)
  if (info.workerState) console.log(`worker state: ${info.workerState}`)
  if (info.verificationState) console.log(`verification state: ${info.verificationState}`)
  if (info.failureCategory) console.log(`failure category: ${info.failureCategory}`)
  if (info.finishedAt) console.log(`finished at: ${info.finishedAt}`)
  console.log(`stale: ${info.stale ? "yes" : "no"}`)
  for (const reason of info.staleReasons ?? []) {
    console.log(`diagnosis reason: ${reason}`)
  }
  console.log(`live web run: ${info.liveWebRun ? "yes" : "no"}`)
  console.log(`dev health: ${info.devServer.health.ok ? "ok" : "down"}${info.devServer.health.error ? ` (${info.devServer.health.error})` : ""}`)
  if (info.devServer.lastHealthCheckAt) console.log(`dev last health check: ${info.devServer.lastHealthCheckAt}`)
  if (info.devServer.lastHealthOkAt) console.log(`dev last healthy: ${info.devServer.lastHealthOkAt}`)
  if (info.devServer.firstHealthFailureAt) console.log(`dev first health failure: ${info.devServer.firstHealthFailureAt}`)
  if (info.devServer.healthChecks !== undefined) console.log(`dev health checks: ${info.devServer.healthChecks}`)
  if (info.devServer.healthFailures !== undefined) console.log(`dev health failures: ${info.devServer.healthFailures}`)
  if (info.devServer.stoppedAt) console.log(`dev server stopped at: ${info.devServer.stoppedAt}`)
  if (info.devServer.exitCode !== undefined || info.devServer.exitSignal) {
    console.log(`dev server exit: code=${info.devServer.exitCode ?? "(none)"} signal=${info.devServer.exitSignal ?? "(none)"}`)
  }
  if (info.devServer.restartCount) console.log(`dev server restarts: ${info.devServer.restartCount}`)
  if (info.devServer.restartedAt) console.log(`dev server restarted at: ${info.devServer.restartedAt}`)
  if (info.devServer.restartLog) console.log(`dev restart log: ${info.devServer.restartLog}`)
  console.log(`task: ${info.taskId ?? "(none)"}`)
  console.log(`target: ${info.target ?? "(none)"}`)
  console.log(`mode: ${info.mode ?? "(none)"}`)
  console.log(`dev env: ${info.devEnv ?? "none"}${info.devEnvSource ? ` (${info.devEnvSource})` : ""}`)
  if (info.projectStacks?.length) console.log(`project stacks: ${info.projectStacks.join(", ")}`)
  if (info.projectProfile) console.log(`project profile: ${info.projectProfile}`)
  if (info.verificationPlan) console.log(`verification plan: ${info.verificationPlan}`)
  if (info.verificationRunners?.length) console.log(`verification runners: ${info.verificationRunners.join(", ")}`)
  if (info.verificationResults?.length) console.log(`verification results: ${info.verificationResults.join(", ")}`)
  console.log(`url: ${info.url || "(none)"}`)
  console.log(`checkout: ${info.checkout ?? "(none)"}`)
  console.log(`log: ${info.logFile ?? "(none)"}`)
  console.log(`run: ${info.runId ?? "(none)"}`)
  console.log(`run file: ${info.runFile ?? "(none)"}`)
  console.log(`browser headless: ${info.browserHeadless ? "yes" : "no"}`)
  console.log(`browser profile: ${info.browserProfile}`)
  console.log(`playwright artifacts: ${info.browserArtifacts}`)
  if (info.commands.openUrl) console.log(`open current app URL: ${info.commands.openUrl}`)
  if (info.commands.tailLog) console.log(`tail worker log: ${info.commands.tailLog}`)
  if (info.commands.recordBrowserEvidence) console.log(`record browser evidence: ${info.commands.recordBrowserEvidence}`)
  console.log(`open worker profile after run: ${info.commands.openProfileAfterRun}`)
  if (info.liveWebRun) {
    console.log("note: do not open the worker profile while Playwright is using it; use the URL/log/artifacts for live observation.")
  }
}

export const browserCommand = async (app: AppCfg, sub: string | undefined, args: string[]) => {
  const json = flag(args, "--json")

  if (sub === "status") {
    const raw = args[2]
    const refs = raw && !raw.startsWith("--")
      ? [raw]
      : [
        ...Object.keys(app.config.agents),
        ...(await listWorkers(app)).map(worker => worker.name),
      ]
    const items = await Promise.all(Array.from(new Set(refs)).map(ref => browserInspection(app, ref)))
    if (json) {
      console.log(JSON.stringify(items, null, 2))
      return
    }
    for (const [index, item] of items.entries()) {
      if (index > 0) console.log("")
      printBrowserInspection(item)
    }
    return
  }

  if (sub === "attach") {
    const id = must(args[2] ?? "", "agentId|role|worker-name")
    const info = await browserInspection(app, id)
    if (json) {
      console.log(JSON.stringify(info, null, 2))
    } else {
      printBrowserInspection(info)
    }
    if (flag(args, "--open")) {
      if (!info.liveWebRun || !info.url) throw new Error(`no live dev URL for ${id}`)
      const result = spawnSync("xdg-open", [info.url], {stdio: "inherit"})
      if (result.status !== 0) throw new Error(`xdg-open exited with code ${result.status ?? -1}`)
    }
    return
  }

  throw new Error("expected browser status|attach")
}
