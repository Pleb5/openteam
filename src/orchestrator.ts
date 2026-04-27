import type {AppCfg, TaskItem, TaskMode} from "./types.js"
import {startJob, startWorker, stopWorker} from "./supervisor.js"
import {statusReport} from "./commands/status.js"

type DispatchResult = {
  handled: boolean
  summary: string
  payload: unknown
  message?: string
}

type WorkerRole = "builder" | "triager" | "qa" | "researcher"

export type DispatchContext = {
  recipients?: string[]
  source?: TaskItem["source"]
}

export type ParsedOperatorRequest =
  | {kind: "help"}
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

const formatStatusReport = (report: Awaited<ReturnType<typeof statusReport>>) => {
  const summary = report.summary
  const lines = [
    "status",
    `managed workers: ${summary.liveManagedWorkers} live / ${summary.managedWorkers} total`,
    `recent runs: ${summary.runningRuns} running, ${summary.staleRuns} stale / ${summary.recentRuns} total`,
    `leases: ${summary.staleLeases} stale / ${summary.leasedContexts} leased`,
  ]

  if (report.workers.length > 0) {
    lines.push(
      "workers:",
      ...report.workers.slice(0, 5).map(worker =>
        `- ${worker.name}: ${worker.running ? "running" : "stopped"} ${worker.role}${worker.target ? ` on ${worker.target}` : ""}`,
      ),
    )
    if (report.workers.length > 5) lines.push(`- ... ${report.workers.length - 5} more`)
  }

  if (report.staleRuns.length > 0) {
    lines.push(`stale runs need attention: ${report.staleRuns.slice(0, 3).map(run => run.runId).join(", ")}`)
  }

  return lines.join("\n")
}

const formatWorkerEntry = (verb: "started" | "launched" | "stopped", entry: {
  name: string
  role?: string
  target?: string
  mode?: TaskMode
  runtimeId?: string
  logFile?: string
}) => [
  `${verb} ${entry.name}`,
  entry.role ? `role: ${entry.role}` : "",
  entry.target ? `target: ${entry.target}` : "",
  entry.mode ? `mode: ${entry.mode}` : "",
  entry.runtimeId ? `runtime: ${entry.runtimeId}` : "",
  entry.logFile ? `log: ${entry.logFile}` : "",
].filter(Boolean).join("\n")

const helpMessage = () => [
  "openteam DM commands",
  "status",
  "worker list",
  "what is running?",
  "stop <worker-name>",
  "start <builder|triager|qa|researcher> on <target> [in web|code mode] [with model <model>]",
  "watch <target> [as builder|triager|qa|researcher] [in web|code mode] [with model <model>]",
  "research <target> [in web|code mode] [with model <model>] [in parallel] and <task>",
  "plan <target> [in web|code mode] [with model <model>] [in parallel] and <goal>",
  "work on <target> [as builder|triager|qa|researcher] [in web|code mode] [with model <model>] [in parallel] and do <task>",
  "",
  "Anything else falls back to the conversational orchestrator.",
].join("\n")

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

  if (/^(help|\?)$/i.test(trimmed)) {
    return {kind: "help"}
  }

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

export const dispatchOperatorRequest = async (
  app: AppCfg,
  request: string,
  context: DispatchContext = {},
): Promise<DispatchResult> => {
  const parsed = parseOperatorRequest(request)
  if (!request.trim()) {
    return {handled: false, summary: "empty request", payload: null}
  }

  if (!parsed) {
    return {handled: false, summary: "request not matched by orchestrator control verbs", payload: null}
  }

  if (parsed.kind === "help") {
    return {handled: true, summary: "listed DM commands", payload: null, message: helpMessage()}
  }

  if (parsed.kind === "status") {
    const report = await statusReport(app)
    const summary = report.summary
    return {
      handled: true,
      summary: `status: ${summary.liveManagedWorkers}/${summary.managedWorkers} managed workers live, ${summary.recentRuns} recent runs, ${summary.staleRuns} stale runs`,
      payload: report,
      message: formatStatusReport(report),
    }
  }

  if (parsed.kind === "stop") {
    const entry = await stopWorker(app, parsed.name)
    return {handled: true, summary: `stopped ${entry.name}`, payload: entry, message: formatWorkerEntry("stopped", entry)}
  }

  if (parsed.kind === "start") {
    const agentId = knownRole(app, parsed.role)
    const entry = await startWorker(app, {
      agentId,
      role: parsed.role,
      target: parsed.target,
      mode: parsed.mode,
      model: parsed.model,
      recipients: context.recipients,
      source: context.source,
    })
    return {handled: true, summary: `started ${entry.name}`, payload: entry, message: formatWorkerEntry("started", entry)}
  }

  if (parsed.kind === "watch") {
    const agentId = knownRole(app, parsed.role)
    const entry = await startWorker(app, {
      agentId,
      role: parsed.role,
      target: parsed.target,
      mode: parsed.mode,
      model: parsed.model,
      recipients: context.recipients,
      source: context.source,
    })
    return {handled: true, summary: `started ${entry.name}`, payload: entry, message: formatWorkerEntry("started", entry)}
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
      recipients: context.recipients,
      source: context.source,
    })
    return {handled: true, summary: `launched ${entry.name}`, payload: entry, message: formatWorkerEntry("launched", entry)}
  }

  return {handled: false, summary: "request not matched by orchestrator control verbs", payload: null}
}
