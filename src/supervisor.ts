import {existsSync} from "node:fs"
import {mkdir, open, readFile, writeFile} from "node:fs/promises"
import {spawn} from "node:child_process"
import path from "node:path"
import {prepareAgent} from "./config.js"
import {assertAppConfigValid} from "./config-validate.js"
import {PROFILE_SYNC_DELAY_MS, sleep, syncGraspServers, syncOwnDmRelays, syncOwnOutboxRelays, syncProfileTokens} from "./nostr.js"
import {encodeTaskContextEnv} from "./task-context.js"
import type {AppCfg, TaskItem, TaskMode, TaskSource} from "./types.js"

export type ManagedWorker = {
  name: string
  kind: "worker" | "job"
  agentId: string
  runtimeId?: string
  role: string
  target?: string
  mode?: TaskMode
  model?: string
  modelProfile?: string
  modelVariant?: string
  task?: string
  subject?: TaskItem["subject"]
  parallel?: boolean
  recipients?: string[]
  source?: TaskSource
  pid: number
  logFile: string
  startedAt: string
}

const now = () => new Date().toISOString()

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "worker"

const jobSlug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "task"

const uniqueSuffix = () => `${Date.now().toString(36)}-${process.pid.toString(36)}`

const defaultJobLimit = (role: string) => {
  if (role === "builder") return 2
  if (role === "researcher") return 2
  if (role === "qa") return 1
  if (role === "triager") return 1
  return 1
}

const stateDir = (app: AppCfg) => path.join(app.config.runtimeRoot, "orchestrator")
const stateFile = (app: AppCfg) => path.join(stateDir(app), "workers.json")

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const load = async (app: AppCfg): Promise<ManagedWorker[]> => {
  const file = stateFile(app)
  if (!existsSync(file)) return []
  return JSON.parse(await readFile(file, "utf8")) as ManagedWorker[]
}

const save = async (app: AppCfg, workers: ManagedWorker[]) => {
  await mkdir(stateDir(app), {recursive: true})
  await writeFile(stateFile(app), `${JSON.stringify(workers, null, 2)}\n`)
}

const pruneDead = async (app: AppCfg) => {
  const workers = await load(app)
  const live = workers.filter(worker => alive(worker.pid))
  if (live.length !== workers.length) {
    await save(app, live)
  }
  return live
}

const seedWorkerIdentity = async (app: AppCfg, agentId: string) => {
  const agent = await prepareAgent(app, agentId)

  await syncOwnOutboxRelays(agent)
  if (agent.agent.role === "orchestrator") {
    await syncOwnDmRelays(agent)
  }

  try {
    await syncProfileTokens(agent)
    await sleep(PROFILE_SYNC_DELAY_MS)
  } catch {}

  try {
    await syncGraspServers(agent)
  } catch {}
}

export const listWorkers = async (app: AppCfg) => {
  const workers = await pruneDead(app)
  return workers.map(worker => ({...worker, running: alive(worker.pid)}))
}

export const startWorker = async (
  app: AppCfg,
  args: {
    agentId: string
    role: string
    target?: string
    mode?: TaskMode
    model?: string
    modelProfile?: string
    modelVariant?: string
    name?: string
    recipients?: string[]
    source?: TaskSource
  },
) => {
  assertAppConfigValid(app, {capability: "serve", agentId: args.agentId, mode: args.mode ?? app.config.repos[app.config.agents[args.agentId]?.repo || ""]?.mode})
  const logsDir = path.join(app.config.runtimeRoot, "logs")
  await mkdir(logsDir, {recursive: true})

  const baseName = args.name || `${args.role}-${slug(args.target || args.agentId)}`
  const workers = await pruneDead(app)
  const existing = workers.find(item => item.name === baseName)
  if (existing && alive(existing.pid)) {
    throw new Error(`worker ${baseName} is already running (pid ${existing.pid})`)
  }

  await seedWorkerIdentity(app, args.agentId)

  const logFile = path.join(logsDir, `${baseName}.log`)
  const handle = await open(logFile, "w")
  const script = path.join(app.root, "scripts", "openteam")
  const cliArgs = ["serve", args.agentId]
  if (args.target) cliArgs.push("--target", args.target)
  if (args.mode) cliArgs.push("--mode", args.mode)
  if (args.model) cliArgs.push("--model", args.model)
  if (args.modelProfile) cliArgs.push("--model-profile", args.modelProfile)
  if (args.modelVariant) cliArgs.push("--variant", args.modelVariant)

  const child = spawn(script, cliArgs, {
    cwd: app.root,
    env: {...process.env, OPENTEAM_CALLER_CWD: process.cwd()},
    detached: true,
    stdio: ["ignore", handle.fd, handle.fd],
  })
  child.unref()
  await handle.close()

  const next: ManagedWorker = {
    name: baseName,
    kind: "worker",
    agentId: args.agentId,
    role: args.role,
    target: args.target,
    mode: args.mode,
    model: args.model,
    modelProfile: args.modelProfile,
    modelVariant: args.modelVariant,
    recipients: args.recipients,
    source: args.source,
    pid: child.pid!,
    logFile,
    startedAt: now(),
  }

  const filtered = workers.filter(item => item.name !== baseName)
  filtered.push(next)
  await save(app, filtered)
  return next
}

export const startJob = async (
  app: AppCfg,
  args: {
    agentId: string
    role: string
    target?: string
    mode?: TaskMode
    model?: string
    modelProfile?: string
    modelVariant?: string
    task: string
    name?: string
    runtimeId?: string
    parallel?: boolean
    recipients?: string[]
    source?: TaskSource
    subject?: TaskItem["subject"]
  },
) => {
  assertAppConfigValid(app, {capability: "launch", agentId: args.agentId, mode: args.mode ?? app.config.repos[app.config.agents[args.agentId]?.repo || ""]?.mode ?? "web"})
  const logsDir = path.join(app.config.runtimeRoot, "logs")
  await mkdir(logsDir, {recursive: true})

  const suffix = uniqueSuffix()
  const baseName = args.name || `${args.role}-job-${slug(args.target || args.agentId)}-${jobSlug(args.task)}-${suffix}`
  const runtimeId = args.runtimeId || `${args.agentId}-${baseName}`
  const workers = await pruneDead(app)
  const existing = workers.find(item => item.name === baseName)
  if (existing && alive(existing.pid)) {
    throw new Error(`worker ${baseName} is already running (pid ${existing.pid})`)
  }

  const activeForRole = workers.filter(item => item.kind === "job" && item.role === args.role && alive(item.pid))
  const limit = defaultJobLimit(args.role)
  if (activeForRole.length >= limit) {
    throw new Error(`role ${args.role} already has ${activeForRole.length}/${limit} active one-off jobs; wait, stop one, or raise the runtime limit in code`)
  }

  await seedWorkerIdentity(app, args.agentId)

  const logFile = path.join(logsDir, `${baseName}.log`)
  const handle = await open(logFile, "w")
  const script = path.join(app.root, "scripts", "openteam")
  const cliArgs = ["launch", args.agentId, "--runtime-id", runtimeId, "--task", args.task, "--attach"]
  if (args.target) cliArgs.push("--target", args.target)
  if (args.mode) cliArgs.push("--mode", args.mode)
  if (args.model) cliArgs.push("--model", args.model)
  if (args.modelProfile) cliArgs.push("--model-profile", args.modelProfile)
  if (args.modelVariant) cliArgs.push("--variant", args.modelVariant)
  if (args.parallel) cliArgs.push("--parallel")
  if (args.subject?.eventId) cliArgs.push("--subject-event", args.subject.eventId)
  if (args.subject?.repoTarget) cliArgs.push("--subject-target", args.subject.repoTarget)
  if (args.subject?.path) cliArgs.push("--subject-path", args.subject.path)

  const child = spawn(script, cliArgs, {
    cwd: app.root,
    env: {...process.env, OPENTEAM_CALLER_CWD: process.cwd(), OPENTEAM_INTERNAL_DETACHED_LAUNCH: "1", ...encodeTaskContextEnv(args)},
    detached: true,
    stdio: ["ignore", handle.fd, handle.fd],
  })
  child.unref()
  await handle.close()

  const next: ManagedWorker = {
    name: baseName,
    kind: "job",
    agentId: args.agentId,
    runtimeId,
    role: args.role,
    target: args.target,
    mode: args.mode,
    model: args.model,
    modelProfile: args.modelProfile,
    modelVariant: args.modelVariant,
    task: args.task,
    subject: args.subject,
    parallel: args.parallel,
    recipients: args.recipients,
    source: args.source,
    pid: child.pid!,
    logFile,
    startedAt: now(),
  }

  const filtered = workers.filter(item => item.name !== baseName)
  filtered.push(next)
  await save(app, filtered)
  return next
}

export const stopWorker = async (app: AppCfg, name: string) => {
  const workers = await load(app)
  const worker = workers.find(item => item.name === name)
  if (!worker) {
    throw new Error(`worker ${name} not found`)
  }

  try {
    process.kill(worker.pid, "SIGTERM")
  } catch {}

  await save(app, workers.filter(item => item.name !== name))
  return worker
}
