import {existsSync} from "node:fs"
import {mkdir, readFile, writeFile} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {getSelfNpub} from "./nostr.js"
import type {AgentMeta, AppCfg, Dict, RootCfg, AgentPaths, RepoCfg, PreparedAgent} from "./types.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const rootDir = path.resolve(__dirname, "..")

const loadEnvFile = async (file: string) => {
  if (!existsSync(file)) return

  const text = await readFile(file, "utf8")
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    const idx = line.indexOf("=")
    if (idx <= 0) continue

    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (!key || process.env[key] !== undefined) continue

    const unquoted =
      (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
        ? value.slice(1, -1)
        : value

    process.env[key] = unquoted
  }
}

const isObj = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const merge = <T>(base: T, patch: unknown): T => {
  if (!isObj(base) || !isObj(patch)) {
    return (patch === undefined ? base : (patch as T))
  }

  const next: Record<string, unknown> = {...base}
  for (const [key, value] of Object.entries(patch)) {
    const prev = next[key]
    if (isObj(prev) && isObj(value)) {
      next[key] = merge(prev, value)
      continue
    }
    next[key] = value
  }
  return next as T
}

const interpolate = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(interpolate)
  }

  if (isObj(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item)]))
  }

  if (typeof value !== "string") {
    return value
  }

  if (value.startsWith("$") && value.length > 1 && !value.includes("/")) {
    return process.env[value.slice(1)] ?? ""
  }

  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key: string) => process.env[key] ?? "")
}

const expandHome = (value: string) => {
  if (value === "~") return os.homedir()
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2))
  return value
}

const resolvePath = (base: string, value: string) => {
  const expanded = expandHome(value)
  if (path.isAbsolute(expanded)) return expanded
  return path.resolve(base, expanded)
}

const readJson = async <T>(file: string): Promise<T> => {
  return JSON.parse(await readFile(file, "utf8")) as T
}

export const loadApp = async (): Promise<AppCfg> => {
  const baseFile = path.join(rootDir, "config", "openteam.json")
  const localFile = path.join(rootDir, "config", "openteam.local.json")
  const secretsFile = path.join(rootDir, "config", "openteam.secrets.env")
  await loadEnvFile(secretsFile)
  const base = await readJson<RootCfg>(baseFile)
  const local = existsSync(localFile) ? await readJson<Partial<RootCfg>>(localFile) : {}
  const merged = interpolate(merge(base, local)) as RootCfg

  const runtimeRoot = resolvePath(rootDir, merged.runtimeRoot)
  const repos = Object.fromEntries(
    (Object.entries(merged.repos) as Array<[string, RepoCfg]>).map(([key, repo]) => [
      key,
      {
        ...repo,
        root: resolvePath(rootDir, repo.root),
        worktreeRoot: resolvePath(rootDir, repo.worktreeRoot),
      },
    ]),
  )

  return {
    root: rootDir,
    config: {
      ...merged,
      runtimeRoot,
      repos,
    },
  }
}

const ensureDir = async (dir: string) => {
  await mkdir(dir, {recursive: true})
}

const today = () => new Date().toISOString().slice(0, 10)

const render = (value: string, vars: Dict) => {
  return value.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "")
}

const readText = async (file: string) => {
  return readFile(file, "utf8")
}

const writeIfMissing = async (file: string, value: string) => {
  if (existsSync(file)) return
  await writeFile(file, value)
}

const writeAlways = async (file: string, value: string) => {
  await writeFile(file, value)
}

export const agentPaths = (app: AppCfg, id: string): AgentPaths => {
  const root = path.join(app.config.runtimeRoot, "agents", id)
  return {
    root,
    workspace: path.join(root, "workspace"),
    memory: path.join(root, "workspace", "memory"),
    tasks: path.join(root, "tasks"),
    queue: path.join(root, "tasks", "queue"),
    history: path.join(root, "tasks", "history"),
    artifacts: path.join(root, "artifacts"),
    browser: path.join(root, "browser"),
    worktrees: path.join(root, "worktrees"),
    stateFile: path.join(root, "state.json"),
  }
}

export const prepareAgent = async (app: AppCfg, id: string): Promise<PreparedAgent> => {
  const metaFile = path.join(app.root, "agents", `${id}.json`)
  const meta = await readJson<AgentMeta>(metaFile)
  const agent = app.config.agents[id]
  if (!agent) {
    throw new Error(`missing config.agents.${id}`)
  }

  const repo = app.config.repos[agent.repo]
  if (!repo) {
    throw new Error(`missing repo config for ${agent.repo}`)
  }

  const paths = agentPaths(app, id)
  await Promise.all([
    ensureDir(paths.workspace),
    ensureDir(paths.memory),
    ensureDir(paths.queue),
    ensureDir(paths.history),
    ensureDir(paths.artifacts),
    ensureDir(paths.browser),
    ensureDir(paths.worktrees),
  ])

  const prepared: PreparedAgent = {app, id, meta, agent, repo, paths}

  let npub = agent.identity.npub || "(unset)"
  try {
    npub = getSelfNpub(prepared)
  } catch {}

  const vars: Dict = {
    agentId: id,
    role: agent.role,
    npub,
    bunkerProfile: agent.identity.bunkerProfile || "(unset)",
    dmRelays: agent.reporting.dmRelays.join(", ") || "(unset)",
  }

  const templateDir = path.join(app.root, "templates")
  const roleText = await readText(path.join(app.root, "roles", `${meta.role}.md`))
  const soulText = await readText(path.join(app.root, "souls", `${meta.soul}.md`))
  const files: Array<[string, string]> = [
    ["AGENTS.md", await readText(path.join(templateDir, "AGENTS.md"))],
    ["SOUL.md", soulText],
    ["ROLE.md", roleText],
    ["IDENTITY.md", render(await readText(path.join(templateDir, "IDENTITY.md")), vars)],
    ["MEMORY.md", await readText(path.join(templateDir, "MEMORY.md"))],
  ]

  for (const [name, value] of files) {
    await writeAlways(path.join(paths.workspace, name), value)
  }

  await writeIfMissing(path.join(paths.memory, `${today()}.md`), `# ${today()}\n\n`)

  return prepared
}
