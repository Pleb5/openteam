import type {AppCfg, TaskMode} from "./types.js"
import {listWorkers, startJob, startWorker, stopWorker} from "./supervisor.js"

type DispatchResult = {
  handled: boolean
  summary: string
  payload: unknown
}

type WorkerRole = "builder" | "triager" | "qa" | "researcher"

export type ParsedOperatorRequest =
  | {kind: "status"}
  | {kind: "stop"; name: string}
  | {kind: "start"; role: WorkerRole; target: string; mode?: TaskMode; model?: string}
  | {kind: "watch"; role: WorkerRole; target: string; mode?: TaskMode; model?: string}
  | {kind: "research"; role: "researcher"; target: string; mode?: TaskMode; model?: string; parallel?: boolean; task: string}
  | {kind: "work"; role: WorkerRole; target: string; mode?: TaskMode; model?: string; parallel?: boolean; task: string}

const rolePattern = "(builder|triager|qa|researcher)"

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
  const match = input.match(new RegExp(`^work on\\s+(.+?)(?:\\s+as\\s+${rolePattern})?(?:\\s+in\\s+(web|code)\\s+mode)?(?:\\s+with\\s+model\\s+(.+?))?(?:\\s+in\\s+parallel)?\\s+and\\s+do\\s+([\\s\\S]+)$`, "i"))
  if (!match) return
  return {
    target: clean(match[1]),
    role: (match[2]?.toLowerCase() || "builder") as WorkerRole,
    mode: parseMode(match[3]?.toLowerCase()),
    model: match[4] ? clean(match[4]) : undefined,
    parallel: /\s+in\s+parallel\s+and\s+do\s+/i.test(input),
    task: clean(match[5]),
  }
}

const parseStart = (input: string) => {
  const match = input.match(new RegExp(`^start\\s+${rolePattern}\\s+on\\s+(.+?)(?:\\s+in\\s+(web|code)\\s+mode)?(?:\\s+with\\s+model\\s+(.+))?$`, "i"))
  if (!match) return
  return {
    role: match[1].toLowerCase() as WorkerRole,
    target: clean(match[2]),
    mode: parseMode(match[3]?.toLowerCase()),
    model: match[4] ? clean(match[4]) : undefined,
  }
}

const parseWatch = (input: string) => {
  const match = input.match(new RegExp(`^watch\\s+(.+?)(?:\\s+as\\s+${rolePattern})?(?:\\s+in\\s+(web|code)\\s+mode)?(?:\\s+with\\s+model\\s+(.+))?$`, "i"))
  if (!match) return
  return {
    target: clean(match[1]),
    role: (match[2]?.toLowerCase() || "triager") as WorkerRole,
    mode: parseMode(match[3]?.toLowerCase()),
    model: match[4] ? clean(match[4]) : undefined,
  }
}

const parseResearch = (input: string) => {
  const match = input.match(/^(research|plan)\s+(.+?)(?:\s+in\s+(web|code)\s+mode)?(?:\s+with\s+model\s+(.+?))?(?:\s+in\s+parallel)?\s+and\s+([\s\S]+)$/i)
  if (!match) return
  const verb = match[1].toLowerCase()
  const task = clean(match[5])
  return {
    target: clean(match[2]),
    role: "researcher" as const,
    mode: parseMode(match[3]?.toLowerCase()) || "code",
    model: match[4] ? clean(match[4]) : undefined,
    parallel: /\s+in\s+parallel\s+and\s+/i.test(input),
    task: verb === "plan" ? `Produce a research-backed implementation plan: ${task}` : task,
  }
}

export const parseOperatorRequest = (request: string): ParsedOperatorRequest | undefined => {
  const trimmed = request.trim()
  if (!trimmed) return

  if (/^(status|worker list|what is running\??)$/i.test(trimmed)) {
    return {kind: "status"}
  }

  const stop = trimmed.match(/^stop\s+(.+)$/i)
  if (stop) {
    return {kind: "stop", name: clean(stop[1])}
  }

  const start = parseStart(trimmed)
  if (start) return {kind: "start", ...start}

  const watch = parseWatch(trimmed)
  if (watch) return {kind: "watch", ...watch}

  const research = parseResearch(trimmed)
  if (research) return {kind: "research", ...research}

  const work = parseWork(trimmed)
  if (work) return {kind: "work", ...work}
}

export const dispatchOperatorRequest = async (app: AppCfg, request: string): Promise<DispatchResult> => {
  const parsed = parseOperatorRequest(request)
  if (!request.trim()) {
    return {handled: false, summary: "empty request", payload: null}
  }

  if (!parsed) {
    return {handled: false, summary: "request not matched by orchestrator control verbs", payload: null}
  }

  if (parsed.kind === "status") {
    const workers = await listWorkers(app)
    return {handled: true, summary: `listed ${workers.length} managed workers`, payload: workers}
  }

  if (parsed.kind === "stop") {
    const entry = await stopWorker(app, parsed.name)
    return {handled: true, summary: `stopped ${entry.name}`, payload: entry}
  }

  if (parsed.kind === "start") {
    const agentId = knownRole(app, parsed.role)
    const entry = await startWorker(app, {
      agentId,
      role: parsed.role,
      target: parsed.target,
      mode: parsed.mode,
      model: parsed.model,
    })
    return {handled: true, summary: `started ${entry.name}`, payload: entry}
  }

  if (parsed.kind === "watch") {
    const agentId = knownRole(app, parsed.role)
    const entry = await startWorker(app, {
      agentId,
      role: parsed.role,
      target: parsed.target,
      mode: parsed.mode,
      model: parsed.model,
    })
    return {handled: true, summary: `started ${entry.name}`, payload: entry}
  }

  if (parsed.kind === "research" || parsed.kind === "work") {
    const agentId = knownRole(app, parsed.role)
    const entry = await startJob(app, {
      agentId,
      role: parsed.role,
      target: parsed.target,
      mode: parsed.mode,
      model: parsed.model,
      task: parsed.task,
      parallel: parsed.parallel,
    })
    return {handled: true, summary: `launched ${entry.name}`, payload: entry}
  }

  return {handled: false, summary: "request not matched by orchestrator control verbs", payload: null}
}
