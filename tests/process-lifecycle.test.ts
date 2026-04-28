import {describe, expect, test} from "bun:test"
import {existsSync} from "node:fs"
import {mkdir, mkdtemp, readFile, utimes, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {checkUrl, diagnoseRun, stopRunRecord} from "../src/commands/runs.js"
import type {AppCfg, RepoContext, RepoRegistry, TaskRunRecord} from "../src/types.js"

const healthyDevUrl = "data:text/plain,ok"

const makeApp = (runtimeRoot: string): AppCfg => ({
  root: process.cwd(),
  config: {
    runtimeRoot,
    opencode: {binary: "opencode", model: "", agent: "build"},
    browser: {
      headless: true,
      executablePath: "/usr/bin/chromium",
      mcp: {name: "playwright", command: [], environment: {}},
    },
    providers: {},
    repos: {
      app: {root: process.cwd(), baseBranch: "main", sharedPaths: [], mode: "code"},
    },
    reporting: {
      dmRelays: [],
      outboxRelays: [],
      relayListBootstrapRelays: [],
      appDataRelays: [],
      signerRelays: [],
      allowFrom: [],
      reportTo: [],
    },
    nostr_git: {
      graspServers: [],
      gitDataRelays: [],
      repoAnnouncementRelays: [],
      forkGitOwner: "",
      forkRepoPrefix: "",
      forkCloneUrlTemplate: "",
    },
    agents: {
      "builder-01": {
        role: "builder",
        soul: "builder",
        repo: "app",
        portStart: 19000,
        reporting: {},
        identity: {npub: "", sec: "1111111111111111111111111111111111111111111111111111111111111111", bunkerProfile: "builder", nakClientKey: ""},
      },
    },
  },
})

const runRecord = (app: AppCfg, patch: Partial<TaskRunRecord> = {}): TaskRunRecord => {
  const runId = patch.runId ?? "builder-01-task-a"
  return {
    version: 1,
    runId,
    runFile: path.join(app.config.runtimeRoot, "runs", `${runId}.json`),
    taskId: patch.taskId ?? "task-a",
    agentId: patch.agentId ?? "builder-01",
    baseAgentId: patch.baseAgentId ?? "builder-01",
    role: patch.role ?? "builder",
    task: patch.task ?? "Verify process lifecycle",
    target: patch.target ?? "repo",
    mode: patch.mode ?? "code",
    state: patch.state ?? "running",
    startedAt: patch.startedAt ?? new Date(Date.now() - 20 * 60_000).toISOString(),
    process: patch.process ?? {runnerPid: 999999999},
    phases: patch.phases ?? [{name: "opencode-worker", state: "running", startedAt: new Date(Date.now() - 20 * 60_000).toISOString()}],
    ...patch,
  }
}

const writeRun = async (record: TaskRunRecord) => {
  await mkdir(path.dirname(record.runFile), {recursive: true})
  await writeFile(record.runFile, `${JSON.stringify(record, null, 2)}\n`)
}

const writeRegistry = async (app: AppCfg, registry: RepoRegistry) => {
  const file = path.join(app.config.runtimeRoot, "repos", "registry.json")
  await mkdir(path.dirname(file), {recursive: true})
  await writeFile(file, `${JSON.stringify(registry, null, 2)}\n`)
}

const leasedContext = (checkout: string, patch: Partial<RepoContext> = {}): RepoContext => ({
  id: patch.id ?? "ctx1",
  repoKey: patch.repoKey ?? "30617:owner:repo",
  path: patch.path ?? path.dirname(checkout),
  checkout,
  mirror: patch.mirror ?? path.join(path.dirname(checkout), "mirror.git"),
  mode: patch.mode ?? "code",
  baseRef: patch.baseRef ?? "HEAD",
  baseCommit: patch.baseCommit ?? "abc123",
  branch: patch.branch ?? "openteam/test",
  state: "leased",
  lease: patch.lease ?? {
    workerId: "builder-01",
    role: "builder",
    jobId: "task-a",
    mode: "code",
    leasedAt: new Date().toISOString(),
  },
  createdAt: patch.createdAt ?? new Date().toISOString(),
  updatedAt: patch.updatedAt ?? new Date().toISOString(),
})

describe("process lifecycle reliability fixtures", () => {
  test("checkUrl accepts a healthy fake dev endpoint", async () => {
    const health = await checkUrl(healthyDevUrl)

    expect(health.ok).toBe(true)
    expect(health.status).toBe(200)
  })

  test("healthy dev URL and live process keep a browser run out of stale state", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    const record = runRecord(app, {
      mode: "web",
      process: {runnerPid: process.pid, devPid: process.pid},
      browser: {enabled: true, headless: true, profileDir: "/tmp/profile", artifactDir: "/tmp/artifacts", url: healthyDevUrl},
      devServer: {url: healthyDevUrl, pid: process.pid, startedAt: new Date().toISOString()},
    })

    const diagnosis = await diagnoseRun(app, record)

    expect(diagnosis.stale).toBe(false)
    expect(diagnosis.devServer.health.ok).toBe(true)
  })

  test("dead process and unhealthy dev URL mark a browser run stale", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    const record = runRecord(app, {
      mode: "web",
      process: {runnerPid: 999999999, devPid: 999999998},
      browser: {enabled: true, headless: true, profileDir: "/tmp/profile", artifactDir: "/tmp/artifacts", url: "http://127.0.0.1:9/health"},
      devServer: {url: "http://127.0.0.1:9/health", pid: 999999998},
    })

    const diagnosis = await diagnoseRun(app, record)

    expect(diagnosis.stale).toBe(true)
    expect(diagnosis.reasons.join("\n")).toContain("all recorded process pids are dead")
    expect(diagnosis.reasons.join("\n")).toContain("URL is not healthy")
  })

  test("stale detection uses task child pid absence and log activity thresholds", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    const logFile = path.join(app.config.runtimeRoot, "agents", "builder-01", "artifacts", "worker.log")
    await mkdir(path.dirname(logFile), {recursive: true})
    await writeFile(logFile, "recent activity\n")
    const recent = runRecord(app, {process: {runnerPid: process.pid}, logs: {opencode: logFile}})

    expect((await diagnoseRun(app, recent)).stale).toBe(false)

    const old = new Date(Date.now() - 20 * 60_000)
    await utimes(logFile, old, old)

    const stale = await diagnoseRun(app, recent)
    expect(stale.stale).toBe(true)
    expect(stale.reasons.join("\n")).toContain("no task-specific child pid evidence")
  })

  test("terminal cleanup marks running phases, dev server stop time, and matching lease release", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    const checkout = path.join(app.config.runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    await writeRegistry(app, {
      version: 1,
      repos: {},
      contexts: {ctx1: leasedContext(checkout)},
      forks: {},
    })
    const record = runRecord(app, {
      context: {id: "ctx1", checkout, branch: "openteam/test"},
      devServer: {url: "http://127.0.0.1:9/health", pid: 999999998, startedAt: new Date().toISOString()},
      process: {runnerPid: 999999999, devPid: 999999998},
    })
    await writeRun(record)

    const result = await stopRunRecord(app, record.runId, "stale")
    const saved = JSON.parse(await readFile(record.runFile, "utf8")) as TaskRunRecord
    const registry = JSON.parse(await readFile(path.join(app.config.runtimeRoot, "repos", "registry.json"), "utf8")) as RepoRegistry

    expect(result.releasedContext).toBe("ctx1")
    expect(saved.state).toBe("stale")
    expect(saved.phases[0]?.state).toBe("stale")
    expect(saved.devServer?.stoppedAt).toBeTruthy()
    expect(registry.contexts.ctx1?.state).toBe("idle")
    expect(existsSync(record.runFile)).toBe(true)
  })
})
