import {createWriteStream} from "node:fs"
import {mkdir} from "node:fs/promises"
import {spawn, type ChildProcess} from "node:child_process"
import net from "node:net"
import path from "node:path"
import process from "node:process"
import {wrapDevEnvCommand, type DevEnv} from "./dev-env.js"
import {redactSensitiveText} from "./log-redaction.js"
import type {PreparedAgent, RepoCfg} from "./types.js"

export type DevServerHealth = {
  ok: boolean
  url?: string
  status?: number
  method?: string
  error?: string
  checkedAt: string
}

export type StartedDevServer = {
  child: ChildProcess
  url: string
  logFile: string
  command: string[]
  processGroup: boolean
}

const isPortFree = async (port: number) => {
  return new Promise<boolean>(resolve => {
    const server = net.createServer()
    server.once("error", () => resolve(false))
    server.once("listening", () => {
      server.close(() => resolve(true))
    })
    server.listen(port, "127.0.0.1")
  })
}

export const nextDevPort = async (start: number, label: string) => {
  for (let offset = 0; offset < 100; offset += 1) {
    const port = start + offset
    if (await isPortFree(port)) return port
  }
  throw new Error(`no free port available near ${start} for ${label}`)
}

export const fillDevCommand = (items: string[], vars: Record<string, string>) =>
  items.map(item => item.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? ""))

export const checkDevHealthOnce = async (url: string, timeoutMs = 1500): Promise<DevServerHealth> => {
  const attempt = async (method: "HEAD" | "GET") => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, {method, signal: controller.signal})
      return {ok: response.status >= 200 && response.status < 500, url, status: response.status, method, checkedAt: new Date().toISOString()}
    } catch (error) {
      return {ok: false, url, method, error: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString()}
    } finally {
      clearTimeout(timer)
    }
  }

  const head = await attempt("HEAD")
  if (head.ok || (head.status && head.status !== 405 && head.status !== 501)) return head
  return attempt("GET")
}

export const waitForDevHealth = async (url: string, timeoutMs = 60_000) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const health = await checkDevHealthOnce(url)
    if (health.ok) return health
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error(`dev server did not become ready at ${url}`)
}

export const processAlive = (pid?: number) => {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const spawnLoggedDevServer = (
  cmd: string,
  args: string[],
  cwd: string,
  logFile: string,
  env: Record<string, string> = {},
  devEnv?: DevEnv,
  options: {detached?: boolean; mirrorOutput?: boolean} = {},
) => {
  const stream = createWriteStream(logFile, {flags: "a"})
  const wrapped = wrapDevEnvCommand(devEnv, cmd, args)
  const child = spawn(wrapped.cmd, wrapped.args, {
    cwd,
    env: {...process.env, ...env},
    stdio: ["ignore", "pipe", "pipe"],
    detached: Boolean(options.detached),
  })

  child.stdout?.on("data", chunk => {
    const text = redactSensitiveText(String(chunk))
    if (options.mirrorOutput) process.stdout.write(text)
    stream.write(text)
  })
  child.stderr?.on("data", chunk => {
    const text = redactSensitiveText(String(chunk))
    if (options.mirrorOutput) process.stderr.write(text)
    stream.write(text)
  })
  child.on("close", () => stream.end())
  if (options.detached) child.unref()
  return child
}

export const startConfiguredDevServer = async (options: {
  repo: Pick<RepoCfg, "root" | "devCommand" | "healthUrl">
  portStart: number
  label: string
  taskId: string
  checkout: string
  logFile: string
  env: Record<string, string>
  devEnv?: DevEnv
  viteConfig?: string
  detached?: boolean
  mirrorOutput?: boolean
  timeoutMs?: number
}): Promise<StartedDevServer> => {
  const {repo, checkout} = options
  if (!repo.devCommand?.length || !repo.healthUrl) {
    throw new Error(`repo ${repo.root} is not configured for web preview`)
  }
  await mkdir(path.dirname(options.logFile), {recursive: true})
  const port = String(await nextDevPort(options.portStart, options.label))
  const url = repo.healthUrl.replace("{port}", port)
  const vars = {port, checkout, repoRoot: checkout, taskId: options.taskId, viteConfig: options.viteConfig ?? ""}
  const command = fillDevCommand(repo.devCommand, vars)
  const [cmd, ...args] = command
  const child = spawnLoggedDevServer(cmd, args, checkout, options.logFile, options.env, options.devEnv, {
    detached: options.detached,
    mirrorOutput: options.mirrorOutput,
  })
  const ready = waitForDevHealth(url, options.timeoutMs)
  const exitBeforeReady = new Promise<never>((_, reject) => {
    const onClose = (code: number | null) => reject(new Error(`dev server exited before ready with code ${code ?? -1}`))
    child.once("close", onClose)
    ready.finally(() => child.off("close", onClose))
  })
  await Promise.race([ready, exitBeforeReady])
  return {child, url, logFile: options.logFile, command, processGroup: Boolean(options.detached)}
}

export const startAgentDevServer = async (
  agent: PreparedAgent,
  taskId: string,
  checkout: string,
  logFile: string,
  env: Record<string, string>,
  devEnv?: DevEnv,
  viteConfig?: string,
) => startConfiguredDevServer({
  repo: agent.repo,
  portStart: agent.agent.portStart,
  label: agent.id,
  taskId,
  checkout,
  logFile,
  env,
  devEnv,
  viteConfig,
  mirrorOutput: true,
})

export const stopChildProcess = async (child: ChildProcess, signal: NodeJS.Signals = "SIGTERM", timeoutMs = 1500) => {
  if (!processAlive(child.pid)) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, timeoutMs)
    child.once("close", () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill(signal)
  })
}

export const stopPid = async (pid: number | undefined, processGroup = false, timeoutMs = 1500) => {
  if (!processAlive(pid)) return false
  const target = processGroup ? -pid! : pid!
  try {
    process.kill(target, "SIGTERM")
  } catch {
    return false
  }
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (!processAlive(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (processAlive(pid)) {
    try {
      process.kill(target, "SIGKILL")
    } catch {}
  }
  return true
}
