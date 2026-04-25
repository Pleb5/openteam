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
    liveWebRun,
    devServer: {
      url,
      health: devHealth,
    },
    taskId: state.taskId,
    target: state.target,
    mode: state.mode,
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
  console.log(`stale: ${info.stale ? "yes" : "no"}`)
  for (const reason of info.staleReasons ?? []) {
    console.log(`stale reason: ${reason}`)
  }
  console.log(`live web run: ${info.liveWebRun ? "yes" : "no"}`)
  console.log(`dev health: ${info.devServer.health.ok ? "ok" : "down"}${info.devServer.health.error ? ` (${info.devServer.health.error})` : ""}`)
  console.log(`task: ${info.taskId ?? "(none)"}`)
  console.log(`target: ${info.target ?? "(none)"}`)
  console.log(`mode: ${info.mode ?? "(none)"}`)
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
