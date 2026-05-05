import {createWriteStream, existsSync} from "node:fs"
import {spawn, spawnSync} from "node:child_process"
import {mkdir, readFile, writeFile} from "node:fs/promises"
import process from "node:process"
import path from "node:path"
import {agentBrowserSessionName, agentBrowserSocketDir} from "./agent-browser-runtime.js"
import {wrapDevEnvCommand, type DevEnv} from "./dev-env.js"
import {projectProfilePath, type ProjectProfile, type ProjectCommandHint} from "./project-profile.js"
import type {
  AppCfg,
  TaskMode,
  VerificationCfg,
  VerificationEvidenceType,
  VerificationPlan,
  VerificationRunnerCfg,
  VerificationRunnerPlan,
  VerificationRunnerResult,
} from "./types.js"

type ProjectProfileLike = {
  stacks?: string[]
}

const VERIFICATION_ARTIFACTS_DIR = path.join(".openteam", "artifacts", "verification")
const AGENT_BROWSER_ARTIFACTS_DIR = path.join(VERIFICATION_ARTIFACTS_DIR, "agent-browser")
const AGENT_BROWSER_ALLOWED_DOMAINS = "127.0.0.1,localhost"
const AGENT_BROWSER_COMMAND = [
  "sh",
  "-c",
  [
    "test -n \"$OPENTEAM_DEV_URL\"",
    "agent-browser --session \"$OPENTEAM_AGENT_BROWSER_SESSION\" --profile \"$OPENTEAM_AGENT_BROWSER_PROFILE_DIR\" --screenshot-dir \"$OPENTEAM_AGENT_BROWSER_ARTIFACTS_DIR\" --allowed-domains \"$AGENT_BROWSER_ALLOWED_DOMAINS\" open \"$OPENTEAM_DEV_URL\"",
    "agent-browser --session \"$OPENTEAM_AGENT_BROWSER_SESSION\" --profile \"$OPENTEAM_AGENT_BROWSER_PROFILE_DIR\" --screenshot-dir \"$OPENTEAM_AGENT_BROWSER_ARTIFACTS_DIR\" wait --load networkidle",
    "agent-browser --session \"$OPENTEAM_AGENT_BROWSER_SESSION\" --profile \"$OPENTEAM_AGENT_BROWSER_PROFILE_DIR\" --screenshot-dir \"$OPENTEAM_AGENT_BROWSER_ARTIFACTS_DIR\" snapshot -i --json --max-output 60000 > \"$OPENTEAM_AGENT_BROWSER_ARTIFACTS_DIR/snapshot.json\"",
    "agent-browser --session \"$OPENTEAM_AGENT_BROWSER_SESSION\" --profile \"$OPENTEAM_AGENT_BROWSER_PROFILE_DIR\" --screenshot-dir \"$OPENTEAM_AGENT_BROWSER_ARTIFACTS_DIR\" screenshot \"$OPENTEAM_AGENT_BROWSER_ARTIFACTS_DIR/page.png\"",
    "agent-browser --session \"$OPENTEAM_AGENT_BROWSER_SESSION\" --profile \"$OPENTEAM_AGENT_BROWSER_PROFILE_DIR\" --screenshot-dir \"$OPENTEAM_AGENT_BROWSER_ARTIFACTS_DIR\" console --json --max-output 60000 > \"$OPENTEAM_AGENT_BROWSER_ARTIFACTS_DIR/console.json\"",
    "agent-browser --session \"$OPENTEAM_AGENT_BROWSER_SESSION\" --profile \"$OPENTEAM_AGENT_BROWSER_PROFILE_DIR\" --screenshot-dir \"$OPENTEAM_AGENT_BROWSER_ARTIFACTS_DIR\" errors --json --max-output 60000 > \"$OPENTEAM_AGENT_BROWSER_ARTIFACTS_DIR/errors.json\"",
    "agent-browser --session \"$OPENTEAM_AGENT_BROWSER_SESSION\" --profile \"$OPENTEAM_AGENT_BROWSER_PROFILE_DIR\" --screenshot-dir \"$OPENTEAM_AGENT_BROWSER_ARTIFACTS_DIR\" close",
  ].join(" && "),
]

export const DEFAULT_VERIFICATION_CONFIG: VerificationCfg = {
  autoRunAfterWorker: false,
  defaultRunners: {
    code: ["repo-native"],
    web: ["repo-native", "agent-browser", "browser"],
  },
  runners: {
    "repo-native": {
      kind: "command",
      enabled: true,
      local: true,
      description: "Repo-native checks selected from project docs, declared scripts, and the project profile.",
      modes: ["code", "web"],
      stacks: [],
    },
    browser: {
      kind: "playwright-mcp",
      enabled: true,
      local: true,
      description: "Local Playwright MCP validation against the openteam-managed browser/dev-server runtime.",
      modes: ["web"],
      stacks: ["web", "node"],
    },
    "agent-browser": {
      kind: "browser-cli",
      enabled: true,
      local: true,
      description: "Default CLI-backed agent-browser verification; Playwright MCP remains available as the browser fallback.",
      command: AGENT_BROWSER_COMMAND,
      modes: ["web"],
      stacks: ["web", "node"],
      artifactsDir: AGENT_BROWSER_ARTIFACTS_DIR,
    },
    "desktop-command": {
      kind: "desktop-command",
      enabled: true,
      local: true,
      description: "Local desktop-app verification through explicit repo-native commands with managed logs, timeouts, and cleanup.",
      modes: ["code"],
      stacks: ["desktop", "electron", "tauri", "gtk", "qt"],
    },
    "android-adb": {
      kind: "android-adb",
      enabled: false,
      local: true,
      description: "Guarded local Android emulator/device verification through ADB or repo-native Android test commands.",
      modes: ["code"],
      stacks: ["android"],
    },
    "ios-simulator": {
      kind: "ios-simulator",
      enabled: false,
      local: true,
      description: "Guarded local iOS simulator verification through simctl/xcodebuild or repo-native iOS test commands.",
      modes: ["code"],
      stacks: ["ios", "swift"],
    },
  },
}

const unique = (items: string[]) => Array.from(new Set(items.filter(Boolean)))
const DEFAULT_TIMEOUT_MS = 10 * 60_000

const mergeRunner = (base: VerificationRunnerCfg | undefined, patch: VerificationRunnerCfg): VerificationRunnerCfg => ({
  ...(base ?? {}),
  ...patch,
  command: patch.command ?? base?.command,
  environment: {...(base?.environment ?? {}), ...(patch.environment ?? {})},
  modes: patch.modes ?? base?.modes,
  stacks: patch.stacks ?? base?.stacks,
})

export const effectiveVerificationConfig = (app: AppCfg): VerificationCfg => {
  const configured = app.config.verification
  const runnerIds = unique([
    ...Object.keys(DEFAULT_VERIFICATION_CONFIG.runners),
    ...Object.keys(configured?.runners ?? {}),
  ])
  const runners = Object.fromEntries(runnerIds.map(id => {
    const base = DEFAULT_VERIFICATION_CONFIG.runners[id]
    const patch = configured?.runners?.[id]
    return [id, patch ? mergeRunner(base, patch) : base]
  }))

  return {
    autoRunAfterWorker: configured?.autoRunAfterWorker ?? DEFAULT_VERIFICATION_CONFIG.autoRunAfterWorker,
    defaultRunners: {
      ...DEFAULT_VERIFICATION_CONFIG.defaultRunners,
      ...(configured?.defaultRunners ?? {}),
    },
    runners,
  }
}

const runnerModes = (runner: VerificationRunnerCfg): TaskMode[] => runner.modes?.length ? runner.modes : ["code", "web"]

const runnerStacks = (runner: VerificationRunnerCfg) => runner.stacks ?? []

const runnerConfigured = (app: AppCfg, id: string, runner: VerificationRunnerCfg) => {
  if (!runner.enabled) return {configured: false, reason: "runner disabled"}
  if (runner.kind === "playwright-mcp" && app.config.browser.mcp.command.length === 0) {
    return {configured: false, reason: "browser.mcp.command is not configured"}
  }
  if (runner.kind === "browser-cli" && !runner.command?.length) {
    return {configured: false, reason: "browser-cli runner requires an explicit command"}
  }
  if (runner.kind === "command" && runner.command && runner.command.length === 0) {
    return {configured: false, reason: "command runner has an empty command"}
  }
  if (!runner.kind) return {configured: false, reason: `runner ${id} has no kind`}
  return {configured: true, reason: undefined}
}

export const createVerificationPlan = (
  app: AppCfg,
  mode: TaskMode,
  projectProfile?: ProjectProfileLike,
): VerificationPlan => {
  const config = effectiveVerificationConfig(app)
  const profileStacks = projectProfile?.stacks ?? []
  const defaultRunnerIds = config.defaultRunners[mode] ?? []
  const stackRunnerIds = Object.entries(config.runners)
    .filter(([, runner]) =>
      runner.enabled &&
      runnerModes(runner).includes(mode) &&
      runnerStacks(runner).some(stack => profileStacks.includes(stack)),
    )
    .map(([id]) => id)
  const selectedRunnerIds = unique([...defaultRunnerIds, ...stackRunnerIds])
  const runners: VerificationRunnerPlan[] = selectedRunnerIds.map(id => {
    const runner = config.runners[id]
    if (!runner) {
      return {
        id,
        kind: "command",
        enabled: false,
        configured: false,
        local: true,
        reason: "runner is referenced but not defined",
        modes: [],
        stacks: [],
      }
    }
    const availability = runnerConfigured(app, id, runner)
    return {
      id,
      kind: runner.kind,
      enabled: runner.enabled,
      configured: availability.configured,
      local: runner.local ?? true,
      description: runner.description,
      reason: availability.reason,
      command: runner.command,
      environment: {
        ...(runner.kind === "browser-cli" && app.config.browser.executablePath ? {AGENT_BROWSER_EXECUTABLE_PATH: app.config.browser.executablePath} : {}),
        ...(runner.environment ?? {}),
      },
      timeoutMs: runner.timeoutMs,
      modes: runnerModes(runner),
      stacks: runnerStacks(runner),
      artifactsDir: runner.artifactsDir,
    }
  })

  return {
    version: 1,
    mode,
    profileStacks,
    selectedRunnerIds,
    runners,
  }
}

export const verificationPlanSummary = (plan: VerificationPlan) =>
  plan.runners.map(runner => `${runner.id}:${runner.configured ? "configured" : "unavailable"}`)

export const writeVerificationPlan = async (checkout: string, plan: VerificationPlan) => {
  const file = verificationPlanPath(checkout)
  await mkdir(path.dirname(file), {recursive: true})
  await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`)
  return file
}

export const verificationPlanPath = (checkout: string) =>
  path.join(checkout, ".openteam", "verification-plan.json")

export const verificationResultsPath = (checkout: string) =>
  path.join(checkout, ".openteam", "verification-results.json")

const readJsonIfExists = async <T>(file: string) => {
  if (!existsSync(file)) return undefined
  return JSON.parse(await readFile(file, "utf8")) as T
}

export const readVerificationPlan = async (checkout: string) => {
  return readJsonIfExists<VerificationPlan>(verificationPlanPath(checkout))
}

export const readVerificationResults = async (checkout: string) => {
  return await readJsonIfExists<VerificationRunnerResult[]>(verificationResultsPath(checkout)) ?? []
}

export const appendVerificationResultsFile = async (checkout: string, results: VerificationRunnerResult[]) => {
  if (results.length === 0) return await readVerificationResults(checkout)
  const file = verificationResultsPath(checkout)
  await mkdir(path.dirname(file), {recursive: true})
  const current = await readVerificationResults(checkout)
  const next = [...current, ...results]
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`)
  return next
}

export const resetVerificationResults = async (checkout: string) => {
  const file = verificationResultsPath(checkout)
  await mkdir(path.dirname(file), {recursive: true})
  await writeFile(file, "[]\n")
  return file
}

export const readProjectProfileForVerification = async (checkout: string) => {
  return readJsonIfExists<ProjectProfile>(projectProfilePath(checkout))
}

const now = () => new Date().toISOString()

export const verificationEvidenceTypeForRunner = (runner: Pick<VerificationRunnerPlan, "id" | "kind">): VerificationEvidenceType => {
  if (runner.id === "repo-native") return "repo-native"
  if (runner.kind === "playwright-mcp" || runner.kind === "browser-cli" || runner.id === "browser") return "browser"
  if (runner.kind === "desktop-command") return "desktop"
  if (runner.kind === "android-adb" || runner.kind === "ios-simulator") return "mobile"
  return "manual"
}

const safeName = (value: string) =>
  value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "runner"

const commandKey = (command: string[]) => command.join("\0")

const firstProfileCommand = (profile?: ProjectProfile) => {
  const commands = profile?.likelyCommands ?? []
  const priority = [
    /check/i,
    /test build/i,
    /build/i,
    /test/i,
    /tasks/i,
  ]
  for (const pattern of priority) {
    const match = commands.find(item => pattern.test(item.purpose) && !/\bdev\b/i.test(item.purpose))
    if (match) return match
  }
  return commands.find(item => !/\bdev\b/i.test(item.purpose))
}

const commandForRunner = (
  runner: VerificationRunnerPlan,
  profile?: ProjectProfile,
): {command?: string[]; source?: ProjectCommandHint; skippedReason?: string} => {
  if (runner.command?.length) return {command: runner.command}
  if (runner.id === "repo-native" || runner.kind === "command") {
    const selected = firstProfileCommand(profile)
    if (selected) return {command: selected.command, source: selected}
    return {skippedReason: "no explicit command configured and no project-profile command hint was available"}
  }
  if (runner.kind === "desktop-command") {
    return {skippedReason: "desktop verification requires an explicit runner command"}
  }
  if (runner.kind === "browser-cli") {
    return {skippedReason: "browser-cli verification requires an explicit runner command"}
  }
  return {skippedReason: "runner has no executable command"}
}

const resolveCheckoutPath = (checkout: string, value: string) =>
  path.isAbsolute(value) ? value : path.join(checkout, value)

const relativeArtifactPath = (checkout: string, value: string) => {
  const relative = path.relative(checkout, value)
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : value
}

const verificationArtifactsDir = async (checkout: string, runner?: VerificationRunnerPlan, env: Record<string, string> = {}) => {
  const baseArtifactsDir = env.OPENTEAM_ARTIFACTS_DIR || process.env.OPENTEAM_ARTIFACTS_DIR
  const value = runner?.kind === "browser-cli" && baseArtifactsDir
    ? path.join(baseArtifactsDir, "verification", runner.id)
    : runner?.artifactsDir ?? VERIFICATION_ARTIFACTS_DIR
  const dir = resolveCheckoutPath(checkout, value)
  await mkdir(dir, {recursive: true})
  return dir
}

const logFileForRunner = async (checkout: string, runner: VerificationRunnerPlan, env: Record<string, string>) =>
  path.join(await verificationArtifactsDir(checkout, runner, env), `${safeName(runner.id)}-${Date.now()}.log`)

const runnerExecutionEnv = async (checkout: string, runner: VerificationRunnerPlan, env: Record<string, string>): Promise<Record<string, string>> => {
  if (runner.kind !== "browser-cli") return {}

  const artifactsDir = await verificationArtifactsDir(checkout, runner, env)
  const profileDir = path.join(artifactsDir, "profile")
  await mkdir(profileDir, {recursive: true})
  const session = agentBrowserSessionName(env.OPENTEAM_RUN_ID || process.env.OPENTEAM_RUN_ID || checkout)
  return {
    AGENT_BROWSER_SOCKET_DIR: agentBrowserSocketDir(env),
    OPENTEAM_AGENT_BROWSER_ARTIFACTS_DIR: artifactsDir,
    OPENTEAM_AGENT_BROWSER_PROFILE_DIR: profileDir,
    OPENTEAM_AGENT_BROWSER_SESSION: session,
    OPENTEAM_BROWSER_CLI_ARTIFACTS_DIR: artifactsDir,
    OPENTEAM_BROWSER_CLI_PROFILE_DIR: profileDir,
    OPENTEAM_BROWSER_CLI_SESSION: session,
    AGENT_BROWSER_ALLOWED_DOMAINS: env.AGENT_BROWSER_ALLOWED_DOMAINS || runner.environment?.AGENT_BROWSER_ALLOWED_DOMAINS || process.env.AGENT_BROWSER_ALLOWED_DOMAINS || AGENT_BROWSER_ALLOWED_DOMAINS,
  }
}

const commandArtifactsForRunner = (checkout: string, runner: VerificationRunnerPlan, executionEnv: Record<string, string>) => {
  if (runner.kind !== "browser-cli") return undefined
  const artifactsDir = executionEnv.OPENTEAM_AGENT_BROWSER_ARTIFACTS_DIR
  return artifactsDir ? [relativeArtifactPath(checkout, artifactsDir)] : undefined
}

const commandAvailable = (cmd: string) => {
  if (path.isAbsolute(cmd) || cmd.includes("/")) return existsSync(cmd)
  return spawnSync("which", [cmd], {encoding: "utf8"}).status === 0
}

const guardAndroid = (runner: VerificationRunnerPlan) => {
  if (!commandAvailable("adb")) return "android-adb runner requires adb on PATH"
  const devices = spawnSync("adb", ["devices"], {encoding: "utf8"})
  if (devices.status !== 0) return devices.stderr.trim() || "adb devices failed"
  const liveDevices = devices.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /\tdevice$/.test(line))
  if (liveDevices.length === 0) return "android-adb runner requires an already-connected device or running emulator"
  if (!runner.command?.length) return "android-adb runner requires an explicit verification command"
  return undefined
}

const guardIos = (runner: VerificationRunnerPlan) => {
  if (process.platform !== "darwin") return "ios-simulator runner requires macOS"
  if (!commandAvailable("xcrun")) return "ios-simulator runner requires xcrun on PATH"
  const devices = spawnSync("xcrun", ["simctl", "list", "devices", "booted"], {encoding: "utf8"})
  if (devices.status !== 0) return devices.stderr.trim() || "xcrun simctl list devices booted failed"
  if (!/\(Booted\)/.test(devices.stdout)) return "ios-simulator runner requires an already-booted simulator"
  if (!runner.command?.length) return "ios-simulator runner requires an explicit verification command"
  return undefined
}

const guardedBlocker = (runner: VerificationRunnerPlan) => {
  if (runner.kind === "android-adb") return guardAndroid(runner)
  if (runner.kind === "ios-simulator") return guardIos(runner)
  return undefined
}

const runCommand = async (
  checkout: string,
  runner: VerificationRunnerPlan,
  command: string[],
  env: Record<string, string>,
  devEnv?: DevEnv,
  source: VerificationRunnerResult["source"] = "worker",
) => {
  const startedAt = now()
  const started = Date.now()
  const executionEnv = await runnerExecutionEnv(checkout, runner, env)
  const logFile = await logFileForRunner(checkout, runner, {...env, ...executionEnv})
  const artifacts = commandArtifactsForRunner(checkout, runner, executionEnv)
  const stream = createWriteStream(logFile, {flags: "a"})
  const [cmd, ...args] = command
  const wrapped = wrapDevEnvCommand(devEnv, cmd, args)
  const child = spawn(wrapped.cmd, wrapped.args, {
    cwd: checkout,
    env: {...process.env, ...env, ...(runner.environment ?? {}), ...executionEnv},
    stdio: ["ignore", "pipe", "pipe"],
  })
  const timeoutMs = runner.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let timedOut = false
  let killTimer: NodeJS.Timeout | undefined
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGTERM")
    killTimer = setTimeout(() => {
      child.kill("SIGKILL")
    }, 1500)
  }, timeoutMs)

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

  let close: {code: number | null; signal: NodeJS.Signals | null}
  try {
    close = await new Promise<{code: number | null; signal: NodeJS.Signals | null}>((resolve, reject) => {
      child.on("error", reject)
      child.on("close", (code, signal) => resolve({code, signal}))
    })
  } catch (error) {
    clearTimeout(timer)
    if (killTimer) clearTimeout(killTimer)
    stream.end()
    return {
      id: runner.id,
      kind: runner.kind,
      state: "failed",
      evidenceType: verificationEvidenceTypeForRunner(runner),
      source,
      startedAt,
      finishedAt: now(),
      durationMs: Math.max(0, Date.now() - started),
      command,
      cwd: checkout,
      logFile,
      artifacts,
      error: error instanceof Error ? error.message : String(error),
    } satisfies VerificationRunnerResult
  } finally {
    clearTimeout(timer)
    if (killTimer) clearTimeout(killTimer)
  }
  stream.end()

  const {code, signal} = close
  const failed = timedOut || code !== 0
  return {
    id: runner.id,
    kind: runner.kind,
    state: failed ? "failed" : "succeeded",
    evidenceType: verificationEvidenceTypeForRunner(runner),
    source,
    startedAt,
    finishedAt: now(),
    durationMs: Math.max(0, Date.now() - started),
    command,
    cwd: checkout,
    logFile,
    artifacts,
    exitCode: code ?? undefined,
    signal: signal ?? undefined,
    error: timedOut ? `verification runner timed out after ${timeoutMs}ms` : code === 0 ? undefined : `${command.join(" ")} exited with code ${code ?? -1}`,
  } satisfies VerificationRunnerResult
}

export const runLocalVerificationRunners = async (options: {
  checkout: string
  plan: VerificationPlan
  profile?: ProjectProfile
  devEnv?: DevEnv
  env?: Record<string, string>
  source?: VerificationRunnerResult["source"]
}) => {
  const results: VerificationRunnerResult[] = []
  const seenCommands = new Set<string>()

  for (const runner of options.plan.runners) {
    if (runner.kind === "playwright-mcp") continue

    if (!runner.enabled || !runner.configured) {
      results.push({
        id: runner.id,
        kind: runner.kind,
        state: "skipped",
        evidenceType: verificationEvidenceTypeForRunner(runner),
        source: options.source ?? "worker",
        skippedReason: runner.reason ?? "runner unavailable",
      })
      continue
    }

    const blocker = guardedBlocker(runner)
    if (blocker) {
      results.push({
        id: runner.id,
        kind: runner.kind,
        state: "blocked",
        evidenceType: verificationEvidenceTypeForRunner(runner),
        source: options.source ?? "worker",
        blocker,
      })
      continue
    }

    const selected = commandForRunner(runner, options.profile)
    if (!selected.command?.length) {
      results.push({
        id: runner.id,
        kind: runner.kind,
        state: "skipped",
        evidenceType: verificationEvidenceTypeForRunner(runner),
        source: options.source ?? "worker",
        skippedReason: selected.skippedReason ?? "no command selected",
      })
      continue
    }

    const key = commandKey(selected.command)
    if (seenCommands.has(key)) {
      results.push({
        id: runner.id,
        kind: runner.kind,
        state: "skipped",
        evidenceType: verificationEvidenceTypeForRunner(runner),
        source: options.source ?? "worker",
        command: selected.command,
        skippedReason: "equivalent command already ran for this verification plan",
      })
      continue
    }
    seenCommands.add(key)

    results.push(await runCommand(
      options.checkout,
      runner,
      selected.command,
      options.env ?? {},
      options.devEnv,
      options.source ?? "worker",
    ))
  }

  return results
}

export const runVerificationRunner = async (options: {
  checkout: string
  plan: VerificationPlan
  runnerId: string
  profile?: ProjectProfile
  devEnv?: DevEnv
  env?: Record<string, string>
  source?: VerificationRunnerResult["source"]
}) => {
  const runner = options.plan.runners.find(item => item.id === options.runnerId)
  if (!runner) {
    throw new Error(`verification runner not found in plan: ${options.runnerId}`)
  }
  if (runner.kind === "playwright-mcp") {
    return [{
      id: runner.id,
      kind: runner.kind,
      state: "skipped",
      evidenceType: verificationEvidenceTypeForRunner(runner),
      source: options.source ?? "worker",
      skippedReason: "browser verification is agent-operated through Playwright MCP; use openteam verify record browser after checking the UI",
    } satisfies VerificationRunnerResult]
  }
  const scopedPlan: VerificationPlan = {
    ...options.plan,
    selectedRunnerIds: [runner.id],
    runners: [runner],
  }
  return runLocalVerificationRunners({
    checkout: options.checkout,
    plan: scopedPlan,
    profile: options.profile,
    devEnv: options.devEnv,
    env: options.env,
    source: options.source,
  })
}

export const manualVerificationResult = (
  runner: VerificationRunnerPlan,
  patch: {
    state: VerificationRunnerResult["state"]
    note?: string
    artifacts?: string[]
    error?: string
    blocker?: string
    skippedReason?: string
    source?: VerificationRunnerResult["source"]
    evidenceType?: VerificationRunnerResult["evidenceType"]
    url?: string
    flow?: string
    consoleSummary?: string
    networkSummary?: string
    eventIds?: string[]
    screenshots?: string[]
    urlHealth?: VerificationRunnerResult["urlHealth"]
  },
): VerificationRunnerResult => ({
  id: runner.id,
  kind: runner.kind,
  state: patch.state,
  evidenceType: patch.evidenceType ?? verificationEvidenceTypeForRunner(runner),
  source: patch.source ?? "worker",
  note: patch.note,
  artifacts: patch.artifacts,
  screenshots: patch.screenshots,
  url: patch.url,
  flow: patch.flow,
  consoleSummary: patch.consoleSummary,
  networkSummary: patch.networkSummary,
  eventIds: patch.eventIds,
  urlHealth: patch.urlHealth,
  error: patch.error,
  blocker: patch.blocker,
  skippedReason: patch.skippedReason,
  startedAt: now(),
  finishedAt: now(),
  durationMs: 0,
})

export const browserVerificationResult = (
  runner: VerificationRunnerPlan | undefined,
  patch: {
    state: "succeeded" | "failed" | "skipped"
    url?: string
    error?: string
    logFile?: string
    skippedReason?: string
  },
): VerificationRunnerResult | undefined => {
  if (!runner) return undefined
  return {
    id: runner.id,
    kind: runner.kind,
    state: patch.state,
    evidenceType: verificationEvidenceTypeForRunner(runner),
    source: "runtime",
    command: patch.url ? ["health-check", patch.url] : undefined,
    logFile: patch.logFile,
    error: patch.error,
    skippedReason: patch.skippedReason,
    startedAt: now(),
    finishedAt: now(),
    durationMs: 0,
  }
}

export const verificationHasFailure = (results: VerificationRunnerResult[]) =>
  results.find(result => result.state === "failed" || result.state === "blocked")
