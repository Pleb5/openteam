import type {AppCfg, TaskMode} from "./types.js"
import {listWorkers, startJob, startWorker, stopWorker} from "./supervisor.js"

type DispatchResult = {
  handled: boolean
  summary: string
  payload: unknown
}

const knownRole = (app: AppCfg, role: string) => {
  const id = Object.keys(app.config.agents).find(key => app.config.agents[key]?.role === role)
  if (!id) throw new Error(`unknown role: ${role}`)
  return id
}

const parseMode = (value?: string): TaskMode | undefined => {
  if (!value) return undefined
  return value === "web" || value === "code" ? value : undefined
}

const clean = (value: string) => value.trim().replace(/^['"]|['"]$/g, "")

const parseWork = (input: string) => {
  const match = input.match(/^work on\s+(.+?)(?:\s+as\s+(builder|triager|qa))?(?:\s+in\s+(web|code)\s+mode)?(?:\s+with\s+model\s+(.+?))?(?:\s+in\s+parallel)?\s+and\s+do\s+([\s\S]+)$/i)
  if (!match) return
  return {
    target: clean(match[1]),
    role: (match[2]?.toLowerCase() || "builder") as "builder" | "triager" | "qa",
    mode: parseMode(match[3]?.toLowerCase()),
    model: match[4] ? clean(match[4]) : undefined,
    parallel: /\s+in\s+parallel\s+and\s+do\s+/i.test(input),
    task: clean(match[5]),
  }
}

const parseStart = (input: string) => {
  const match = input.match(/^start\s+(builder|triager|qa)\s+on\s+(.+?)(?:\s+in\s+(web|code)\s+mode)?(?:\s+with\s+model\s+(.+))?$/i)
  if (!match) return
  return {
    role: match[1].toLowerCase() as "builder" | "triager" | "qa",
    target: clean(match[2]),
    mode: parseMode(match[3]?.toLowerCase()),
    model: match[4] ? clean(match[4]) : undefined,
  }
}

const parseWatch = (input: string) => {
  const match = input.match(/^watch\s+(.+?)(?:\s+as\s+(builder|triager|qa))?(?:\s+in\s+(web|code)\s+mode)?(?:\s+with\s+model\s+(.+))?$/i)
  if (!match) return
  return {
    target: clean(match[1]),
    role: (match[2]?.toLowerCase() || "triager") as "builder" | "triager" | "qa",
    mode: parseMode(match[3]?.toLowerCase()),
    model: match[4] ? clean(match[4]) : undefined,
  }
}

export const dispatchOperatorRequest = async (app: AppCfg, request: string): Promise<DispatchResult> => {
  const trimmed = request.trim()
  if (!trimmed) {
    return {handled: false, summary: "empty request", payload: null}
  }

  if (/^(status|worker list|what is running\??)$/i.test(trimmed)) {
    const workers = await listWorkers(app)
    return {handled: true, summary: `listed ${workers.length} managed workers`, payload: workers}
  }

  const stop = trimmed.match(/^stop\s+(.+)$/i)
  if (stop) {
    const entry = await stopWorker(app, clean(stop[1]))
    return {handled: true, summary: `stopped ${entry.name}`, payload: entry}
  }

  const start = parseStart(trimmed)
  if (start) {
    const agentId = knownRole(app, start.role)
    const entry = await startWorker(app, {
      agentId,
      role: start.role,
      target: start.target,
      mode: start.mode,
      model: start.model,
    })
    return {handled: true, summary: `started ${entry.name}`, payload: entry}
  }

  const watch = parseWatch(trimmed)
  if (watch) {
    const agentId = knownRole(app, watch.role)
    const entry = await startWorker(app, {
      agentId,
      role: watch.role,
      target: watch.target,
      mode: watch.mode,
      model: watch.model,
    })
    return {handled: true, summary: `started ${entry.name}`, payload: entry}
  }

  const work = parseWork(trimmed)
  if (work) {
    const agentId = knownRole(app, work.role)
    const entry = await startJob(app, {
      agentId,
      role: work.role,
      target: work.target,
      mode: work.mode,
      model: work.model,
      task: work.task,
      parallel: work.parallel,
    })
    return {handled: true, summary: `launched ${entry.name}`, payload: entry}
  }

  return {handled: false, summary: "request not matched by orchestrator control verbs", payload: null}
}
