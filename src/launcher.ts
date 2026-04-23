import {createWriteStream} from "node:fs"
import {existsSync} from "node:fs"
import {mkdir, readFile, rename, rm, symlink, writeFile} from "node:fs/promises"
import {readdir} from "node:fs/promises"
import {spawn} from "node:child_process"
import net from "node:net"
import path from "node:path"
import process from "node:process"
import {startBunker, type RunningBunker} from "./bunker.js"
import {prepareAgent} from "./config.js"
import {pollInboundTasks, subscribeInboundTasks} from "./dm.js"
import {
  graspServers,
  getSelfNpub,
  sendDm,
  sendReport,
  syncGraspServers,
  syncProfileTokens,
  syncOwnDmRelays,
  syncOwnOutboxRelays,
} from "./nostr.js"
import type {AppCfg, LaunchResult, PreparedAgent, TaskItem, AgentRuntimeState} from "./types.js"

type AgentRuntime = {
  bunker?: RunningBunker
}

const slug = (value: string) => {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "task"
}

const now = () => new Date().toISOString()
const nowSec = () => Math.floor(Date.now() / 1000)

const ensureDir = async (dir: string) => {
  await mkdir(dir, {recursive: true})
}

const taskId = (task: string) => `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${slug(task)}`

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

const nextPort = async (agent: PreparedAgent) => {
  for (let offset = 0; offset < 100; offset++) {
    const port = agent.agent.portStart + offset
    if (await isPortFree(port)) {
      return port
    }
  }

  throw new Error(`no free port available near ${agent.agent.portStart} for ${agent.id}`)
}

const fill = (items: string[], vars: Record<string, string>) => items.map(item => item.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? ""))

const health = async (url: string, timeoutMs = 60_000) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await fetch(url)
      if (result.ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error(`dev server did not become ready at ${url}`)
}

const spawnLogged = (
  cmd: string,
  args: string[],
  cwd: string,
  logFile: string,
  env: Record<string, string> = {},
) => {
  const stream = createWriteStream(logFile, {flags: "a"})
  const child = spawn(cmd, args, {
    cwd,
    env: {...process.env, ...env},
    stdio: ["ignore", "pipe", "pipe"],
  })

  child.stdout.on("data", chunk => {
    const text = String(chunk)
    process.stdout.write(text)
    stream.write(text)
  })

  child.stderr.on("data", chunk => {
    const text = String(chunk)
    process.stderr.write(text)
    stream.write(text)
  })

  child.on("close", () => {
    stream.end()
  })

  return child
}

const run = async (cmd: string, args: string[], cwd: string) => {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {cwd, stdio: "inherit"})
    child.on("error", reject)
    child.on("close", code => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${cmd} exited with code ${code ?? -1}`))
    })
  })
}

const attachFiles = (agent: PreparedAgent) => {
  return [
    path.join(agent.paths.workspace, "AGENTS.md"),
    path.join(agent.paths.workspace, "SOUL.md"),
    path.join(agent.paths.workspace, "ROLE.md"),
    path.join(agent.paths.workspace, "IDENTITY.md"),
    path.join(agent.paths.workspace, "MEMORY.md"),
  ]
}

const compose = (agent: PreparedAgent, task: string, url: string, runtime?: AgentRuntime) => {
  const grasp = graspServers(agent)
  return [
    `You are ${agent.id}, a ${agent.meta.role} worker in openteam.`,
    `Read the attached bootstrap files first and follow them.`,
    `Target repo: ${agent.meta.repo}`,
    `Local app URL: ${url}`,
    runtime?.bunker?.uri
      ? `Remote signer bunker URL: ${runtime.bunker.uri}`
      : `Remote signer bunker URL: unavailable`,
    grasp.length > 0 ? `Configured GRASP relays: ${grasp.join(", ")}` : `Configured GRASP relays: none`,
    `Task: ${task}`,
    `Operator task-status DMs are handled by openteam runtime; focus on the task itself unless the task explicitly requires Nostr messaging work.`,
    `Use the browser MCP if available to verify UI behavior before you claim success.`,
    `If the target app requires login, use the Remote Signer flow with the bunker URL above when appropriate.`,
    `Keep working until the task is handled end-to-end or you hit a concrete blocker.`,
  ].join("\n")
}

const writeOcfg = async (agent: PreparedAgent, worktree: string, runtime?: AgentRuntime) => {
  const mcp = agent.app.config.browser.mcp
  if (mcp.command.length === 0) return

  const dir = path.join(worktree, ".opencode")
  await ensureDir(dir)
  const browserProfile = path.join(agent.paths.browser, "profile")
  const browserOutput = path.join(agent.paths.artifacts, "playwright")
  await ensureDir(browserProfile)
  await ensureDir(browserOutput)

  const command = [...mcp.command]
  if (agent.app.config.browser.executablePath) {
    command.push("--executable-path", agent.app.config.browser.executablePath)
  }
  command.push("--user-data-dir", browserProfile)
  command.push("--output-dir", browserOutput)
  command.push("--save-session")
  command.push("--sandbox")
  if (agent.app.config.browser.headless) {
    command.push("--headless")
  }

  const cfg = {
    mcp: {
      [mcp.name]: {
        type: "local",
        enabled: true,
        command,
        environment: {
          ...mcp.environment,
          OPENTEAM_BROWSER_PROFILE: path.join(agent.paths.browser, "profile"),
          OPENTEAM_BUNKER_URL: runtime?.bunker?.uri ?? "",
          OPENTEAM_AGENT_NPUB: getSelfNpub(agent),
        },
      },
    },
  }

  await writeFile(path.join(dir, "opencode.json"), `${JSON.stringify(cfg, null, 2)}\n`)
}

const linkShared = async (agent: PreparedAgent, worktree: string) => {
  for (const item of agent.repo.sharedPaths) {
    const src = path.join(agent.repo.root, item)
    const dest = path.join(worktree, item)
    if (!existsSync(src) || existsSync(dest)) continue
    await symlink(src, dest)
  }
}

const createWorktree = async (agent: PreparedAgent, id: string, runtime?: AgentRuntime) => {
  const worktree = path.join(agent.paths.worktrees, id)
  const branch = `openteam/${agent.id}/${id}`

  if (!existsSync(worktree)) {
    await ensureDir(agent.paths.worktrees)
    await run("git", ["worktree", "add", "-b", branch, worktree, agent.repo.baseBranch], agent.repo.root)
  }

  await linkShared(agent, worktree)
  await writeOcfg(agent, worktree, runtime)
  return {worktree, branch}
}

const writeViteWrapper = async (agent: PreparedAgent, worktree: string) => {
  const file = path.join(worktree, ".openteam.vite.config.ts")
  const allow = [agent.repo.root, path.join(agent.repo.root, "node_modules")]
  const content = [
    'import {mergeConfig} from "vite"',
    'import baseConfig from "./vite.config"',
    "",
    "export default mergeConfig(baseConfig, {",
    "  server: {",
    "    fs: {",
    `      allow: ${JSON.stringify(allow)},`,
    "    },",
    "  },",
    "})",
    "",
  ].join("\n")
  await writeFile(file, content)
  return file
}

const startDev = async (agent: PreparedAgent, task: string, worktree: string) => {
  const port = String(await nextPort(agent))
  const url = agent.repo.healthUrl.replace("{port}", port)
  const viteConfig = await writeViteWrapper(agent, worktree)
  const vars = {port, worktree, taskId: task, viteConfig}
  const [cmd, ...args] = fill(agent.repo.devCommand, vars)
  const logFile = path.join(agent.paths.artifacts, `${task}-dev.log`)
  const child = spawnLogged(cmd, args, worktree, logFile)
  const ready = health(url)

  const exitBeforeReady = new Promise<never>((_, reject) => {
    const onClose = (code: number | null) => {
      reject(new Error(`dev server exited before ready with code ${code ?? -1}`))
    }

    child.once("close", onClose)

    ready.finally(() => {
      child.off("close", onClose)
    })
  })

  await Promise.race([ready, exitBeforeReady])
  return {child, url, logFile}
}

const wait = async (child: ReturnType<typeof spawnLogged>) => {
  return new Promise<number>((resolve, reject) => {
    child.on("error", reject)
    child.on("close", code => resolve(code ?? 1))
  })
}

const writeState = async (agent: PreparedAgent, value: unknown) => {
  await writeFile(agent.paths.stateFile, `${JSON.stringify(value, null, 2)}\n`)
}

const loadState = async (agent: PreparedAgent): Promise<AgentRuntimeState> => {
  if (!existsSync(agent.paths.stateFile)) return {}
  return JSON.parse(await readFile(agent.paths.stateFile, "utf8")) as AgentRuntimeState
}

const mergeState = async (agent: PreparedAgent, patch: Partial<AgentRuntimeState>) => {
  const current = await loadState(agent)
  const next = {...current, ...patch}
  await writeState(agent, next)
  return next
}

const writeRuntimeIdentity = async (agent: PreparedAgent, runtime?: AgentRuntime) => {
  const lines = [
    "# Identity",
    "",
    `- agent id: ${agent.id}`,
    `- role: ${agent.agent.role}`,
    `- npub: ${getSelfNpub(agent)}`,
    `- bunker profile: ${agent.agent.identity.bunkerProfile || "(unset)"}`,
    `- bunker uri: ${runtime?.bunker?.uri ?? "(not running)"}`,
  ]
  await writeFile(path.join(agent.paths.workspace, "IDENTITY.md"), `${lines.join("\n")}\n`)
}

const startRuntime = async (agent: PreparedAgent): Promise<AgentRuntime> => {
  try {
    await syncOwnOutboxRelays(agent)
    await syncOwnDmRelays(agent)
  } catch (error) {
    process.stderr.write(`relay-list sync skipped: ${String(error)}\n`)
  }

  const runtime: AgentRuntime = {
    bunker: await startBunker(agent),
  }
  await writeRuntimeIdentity(agent, runtime)
  await mergeState(agent, {
    bunkerUri: runtime.bunker?.uri,
    bunkerPid: runtime.bunker?.child.pid,
  })
  return runtime
}

const stopRuntime = async (agent: PreparedAgent, runtime?: AgentRuntime) => {
  runtime?.bunker?.stop()
  await writeRuntimeIdentity(agent)
  await mergeState(agent, {bunkerUri: undefined, bunkerPid: undefined})
}

const record = async (agent: PreparedAgent, item: TaskItem) => {
  const file = path.join(agent.paths.history, `${item.id}.json`)
  await writeFile(file, `${JSON.stringify(item, null, 2)}\n`)
}

export const enqueueTask = async (
  app: AppCfg,
  id: string,
  task: string,
  overrides: Partial<TaskItem> = {},
) => {
  const agent = await prepareAgent(app, id)
  const item: TaskItem = {
    id: overrides.id ?? taskId(task),
    task,
    createdAt: now(),
    state: "queued",
    agentId: id,
    recipients: overrides.recipients,
    source: overrides.source ?? {kind: "local"},
  }

  const file = path.join(agent.paths.queue, `${item.id}.json`)
  await writeFile(file, `${JSON.stringify(item, null, 2)}\n`)
  return file
}

const nextQueued = async (agent: PreparedAgent) => {
  if (!existsSync(agent.paths.queue)) return
  const entries = (await readdir(agent.paths.queue)).filter(item => item.endsWith(".json")).sort()

  if (entries.length === 0) return
  const file = path.join(agent.paths.queue, entries[0])
  const item = JSON.parse(await readFile(file, "utf8")) as TaskItem
  return {file, item}
}

const toTaskItem = (id: string, input: string | TaskItem): TaskItem => {
  if (typeof input !== "string") return input
  return {
    id: taskId(input),
    task: input,
    createdAt: now(),
    state: "queued",
    agentId: id,
    source: {kind: "local"},
  }
}

export const runTask = async (
  app: AppCfg,
  id: string,
  input: string | TaskItem,
  runtime?: AgentRuntime,
): Promise<LaunchResult> => {
  const agent = await prepareAgent(app, id)
  const item = toTaskItem(id, input)
  const idTask = item.id
  const ownedRuntime = runtime ?? (await startRuntime(agent))
  const shouldStopRuntime = !runtime
  const {worktree, branch} = await createWorktree(agent, idTask, ownedRuntime)

  await mergeState(agent, {running: true, taskId: idTask, task: item.task, startedAt: now(), worktree, branch})
  if (item.source?.kind !== "dm") {
    await sendReport(agent, `[${agent.id}] starting task ${idTask}\n\n${item.task}`, item.recipients)
  }

  try {
    try {
      await syncProfileTokens(agent)
    } catch (error) {
      process.stderr.write(`token sync skipped: ${String(error)}\n`)
    }

    try {
      await syncGraspServers(agent)
    } catch (error) {
      process.stderr.write(`grasp server sync skipped: ${String(error)}\n`)
    }

    const dev = await startDev(agent, idTask, worktree)
    const logFile = path.join(agent.paths.artifacts, `${idTask}-opencode.log`)
    const prompt = compose(agent, item.task, dev.url, ownedRuntime)
    const files = attachFiles(agent)
    const args = ["run", "--dir", worktree, "--agent", agent.app.config.opencode.agent, "--title", idTask]

    if (agent.app.config.opencode.model) {
      args.push("--model", agent.app.config.opencode.model)
    }

    for (const file of files) {
      args.push("--file", file)
    }

    // `--file` is an array option in opencode's CLI parser, so terminate option parsing
    // before passing the positional message or yargs will treat the prompt as another file.
    args.push("--", prompt)

    const child = spawnLogged(agent.app.config.opencode.binary, args, agent.app.root, logFile)
    const code = await wait(child)
    dev.child.kill("SIGTERM")

    const state = code === 0 ? "succeeded" : "failed"
    const result: LaunchResult = {
      id: idTask,
      state,
      task: item.task,
      worktree,
      branch,
      url: dev.url,
      logFile,
    }

    await mergeState(agent, {...result, finishedAt: now(), running: false})
    await sendReport(
      agent,
      [
        `[${agent.id}] ${state} task ${idTask}`,
        `url: ${dev.url}`,
        `worktree: ${worktree}`,
        `branch: ${branch}`,
        `log: ${logFile}`,
      ].join("\n"),
      item.recipients,
    )

    return result
  } finally {
    if (shouldStopRuntime) {
      await stopRuntime(agent, ownedRuntime)
    }
  }
}

export const prepareOnly = async (app: AppCfg, id: string) => {
  const agent = await prepareAgent(app, id)
  await mergeState(agent, {preparedAt: now(), running: false})
  return agent
}

const markSeen = async (agent: PreparedAgent, ids: string[]) => {
  const state = await loadState(agent)
  const next = [...(state.seenDmIds ?? []), ...ids]
  await mergeState(agent, {seenDmIds: Array.from(new Set(next)).slice(-500)})
}

const acceptInbound = async (app: AppCfg, agent: PreparedAgent, body: string, id: string, fromNpub: string) => {
  const file = await enqueueTask(app, agent.id, body, {
    id,
    recipients: [fromNpub],
    source: {
      kind: "dm",
      eventId: id,
      from: fromNpub,
    },
  })
  await sendDm(agent, `working on it\ntask: ${id}`, [fromNpub])
  return file
}

const pollInbox = async (app: AppCfg, agent: PreparedAgent) => {
  const state = await loadState(agent)
  const since = Math.max(0, (state.lastDmCheckAt ?? nowSec()) - 15)
  const seenIds = new Set(state.seenDmIds ?? [])
  const inbound = await pollInboundTasks(agent, since, seenIds)

  if (inbound.length === 0) {
    await mergeState(agent, {lastDmCheckAt: nowSec()})
    return
  }

  for (const message of inbound) {
    await acceptInbound(app, agent, message.body, message.id, message.fromNpub)
  }

  await markSeen(
    agent,
    inbound.map(item => item.id),
  )
  await mergeState(agent, {lastDmCheckAt: nowSec()})
}

export const serveAgent = async (app: AppCfg, id: string) => {
  const agent = await prepareAgent(app, id)
  const runtime = await startRuntime(agent)
  let active: Promise<void> | undefined
  const pollInterval = agent.agent.reporting.pollIntervalMs ?? app.config.reporting.pollIntervalMs ?? 5000
  let sub = {close: () => {}}
  let closed = false
  let broken = false
  let inbox = Promise.resolve()

  const arm = async () => {
    const state = await loadState(agent)
    const seenIds = new Set(state.seenDmIds ?? [])

    sub = await subscribeInboundTasks(
      agent,
      Math.max(0, (state.lastDmCheckAt ?? nowSec()) - 15),
      seenIds,
      message => {
        inbox = inbox
          .then(async () => {
            await acceptInbound(app, agent, message.body, message.id, message.fromNpub)
            await markSeen(agent, [message.id])
            await mergeState(agent, {lastDmCheckAt: nowSec()})
          })
          .catch(error => {
            process.stderr.write(`dm subscription handler failed: ${String(error)}\n`)
          })
      },
      reasons => {
        if (closed) return
        broken = true
        const joined = reasons.join("; ")
        if (joined) {
          process.stderr.write(`dm subscription closed: ${joined}\n`)
        }
      },
    )
    broken = false
  }

  const cleanup = () => {
    closed = true
    sub.close()
    runtime.bunker?.stop()
  }

  process.once("SIGINT", cleanup)
  process.once("SIGTERM", cleanup)

  try {
    await pollInbox(app, agent)
  } catch (error) {
    process.stderr.write(`dm poll failed: ${String(error)}\n`)
  }

  try {
    await arm()
  } catch (error) {
    broken = true
    process.stderr.write(`dm subscription failed: ${String(error)}\n`)
  }

  for (;;) {
    if (broken) {
      try {
        await arm()
      } catch (error) {
        process.stderr.write(`dm subscription failed: ${String(error)}\n`)
      }
    }

    try {
      await pollInbox(app, agent)
    } catch (error) {
      process.stderr.write(`dm fallback poll failed: ${String(error)}\n`)
    }

    if (!active) {
      const next = await nextQueued(agent)
      if (next) {
        const runningFile = path.join(agent.paths.history, `${next.item.id}.running.json`)
        await rename(next.file, runningFile)
        active = (async () => {
          try {
            const result = await runTask(app, id, next.item, runtime)
            await record(agent, {...next.item, state: result.state})
          } catch (error) {
            await record(agent, {...next.item, state: "failed"})
            process.stderr.write(`${String(error)}\n`)
          } finally {
            await rm(runningFile, {force: true})
            active = undefined
          }
        })()
      }
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval))
  }
}
