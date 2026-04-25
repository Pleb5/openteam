import {afterEach, describe, expect, test} from "bun:test"
import {existsSync} from "node:fs"
import {mkdir, mkdtemp, readFile, writeFile} from "node:fs/promises"
import {spawnSync} from "node:child_process"
import {tmpdir} from "node:os"
import path from "node:path"
import {browserInspection} from "../src/commands/browser.js"
import {acceptsControlDms} from "../src/commands/profile.js"
import {stopRunRecord, summarizeRuns} from "../src/commands/runs.js"
import {prepareAgent} from "../src/config.js"
import {assertControlAllowed} from "../src/control-guard.js"
import {assertResolvedContextReady, provisionWorkerControlCommand} from "../src/launcher.js"
import {resolveRepoTarget} from "../src/repo.js"
import type {AppCfg, RepoRegistry, ResolvedRepoTarget, TaskItem, TaskRunRecord} from "../src/types.js"
import {getPublicKey, nip19} from "nostr-tools"

const sec = "1111111111111111111111111111111111111111111111111111111111111111"
const ownerPubkey = getPublicKey(new Uint8Array(Buffer.from(sec, "hex")))
const ownerNpub = nip19.npubEncode(ownerPubkey)

const runGit = (cwd: string, args: string[]) => {
  const result = spawnSync("git", args, {cwd, encoding: "utf8"})
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`)
  }
  return result.stdout.trim()
}

const makeApp = (runtimeRoot: string): AppCfg => ({
  root: process.cwd(),
  config: {
    runtimeRoot,
    opencode: {binary: "opencode", model: "", agent: "build"},
    browser: {
      headless: false,
      executablePath: "/usr/bin/chromium",
      mcp: {name: "playwright", command: ["bunx", "@playwright/mcp@latest"], environment: {}},
    },
    providers: {"github.com": {type: "github", host: "github.com", token: "token"}},
    repos: {
      app: {
        root: process.cwd(),
        baseBranch: "master",
        sharedPaths: [],
        mode: "web",
      },
      control: {
        root: process.cwd(),
        baseBranch: "master",
        sharedPaths: [],
        mode: "code",
      },
    },
    reporting: {
      dmRelays: ["wss://dm.example.com"],
      outboxRelays: ["wss://outbox.example.com"],
      relayListBootstrapRelays: ["wss://bootstrap.example.com"],
      appDataRelays: ["wss://app.example.com"],
      signerRelays: ["wss://signer.example.com"],
      allowFrom: [],
      reportTo: [],
      pollIntervalMs: 5000,
    },
    nostr_git: {
      graspServers: [],
      gitDataRelays: ["wss://git.example.com"],
      repoAnnouncementRelays: ["wss://repo.example.com"],
      forkGitOwner: "",
      forkRepoPrefix: "",
      forkCloneUrlTemplate: "",
    },
    agents: {
      "builder-01": {
        role: "builder",
        soul: "builder",
        repo: "app",
        portStart: 18471,
        reporting: {},
        identity: {npub: "", sec, bunkerProfile: "builder-01", nakClientKey: ""},
        nostr_git: {},
      },
      "orchestrator-01": {
        role: "orchestrator",
        soul: "orchestrator",
        repo: "control",
        portStart: 18470,
        reporting: {},
        identity: {npub: "", sec, bunkerProfile: "orchestrator-01", nakClientKey: ""},
        nostr_git: {},
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
    taskId: "task-a",
    agentId: "builder-01",
    baseAgentId: "builder-01",
    role: "builder",
    task: "test task",
    target: "nostr://npub1example/repo",
    mode: "code",
    state: "running",
    startedAt: "2026-04-25T00:00:00.000Z",
    process: {runnerPid: 999999999},
    phases: [{name: "opencode-worker", state: "running", startedAt: "2026-04-25T00:00:00.000Z"}],
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
  return file
}

const registryWithContext = (checkout: string, lease: RepoRegistry["contexts"][string]["lease"]): RepoRegistry => ({
  version: 1,
  repos: {},
  forks: {},
  contexts: {
    ctx1: {
      id: "ctx1",
      repoKey: "30617:owner:repo",
      path: path.dirname(checkout),
      checkout,
      mirror: "/tmp/mirror.git",
      mode: "code",
      baseRef: "HEAD",
      baseCommit: "abc123",
      branch: "openteam/test",
      state: "leased",
      lease,
      createdAt: "2026-04-25T00:00:00.000Z",
      updatedAt: "2026-04-25T00:00:00.000Z",
    },
  },
})

afterEach(() => {
  delete process.env.OPENTEAM_PHASE
})

describe("runtime invariants", () => {
  test("same repo serializes unless explicit parallel mode is requested", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const repo = await mkdtemp(path.join(tmpdir(), "openteam-repo-"))
    runGit(repo, ["init"])
    runGit(repo, ["config", "user.email", "test@example.com"])
    runGit(repo, ["config", "user.name", "Test User"])
    await writeFile(path.join(repo, "README.md"), "test\n")
    runGit(repo, ["add", "README.md"])
    runGit(repo, ["commit", "-m", "initial"])

    const app = makeApp(runtimeRoot)
    app.config.repos.app.mode = "code"
    const registryFile = await writeRegistry(app, {
      version: 1,
      forks: {},
      contexts: {},
      repos: {
        [`30617:${ownerPubkey}:repo`]: {
          key: `30617:${ownerPubkey}:repo`,
          ownerPubkey,
          ownerNpub,
          identifier: "repo",
          announcementEventId: "event",
          announcedAt: 1,
          relays: [],
          cloneUrls: [repo],
          rawTags: [["d", "repo"], ["clone", repo]],
        },
      },
    })
    const agent = await prepareAgent(app, "builder-01")

    const first = await resolveRepoTarget(app, agent, {
      id: "task-a",
      task: "first",
      createdAt: "",
      state: "queued",
      agentId: "builder-01",
      target: "repo",
      mode: "code",
    })

    await expect(resolveRepoTarget(app, agent, {
      id: "task-b",
      task: "second",
      createdAt: "",
      state: "queued",
      agentId: "builder-01",
      target: "repo",
      mode: "code",
    })).rejects.toThrow("is busy")

    const parallel = await resolveRepoTarget(app, agent, {
      id: "task-c",
      task: "parallel",
      createdAt: "",
      state: "queued",
      agentId: "builder-01",
      target: "repo",
      mode: "code",
      parallel: true,
    })
    const registry = JSON.parse(await readFile(registryFile, "utf8")) as RepoRegistry

    expect(first.context.id).not.toBe(parallel.context.id)
    expect(Object.values(registry.contexts).filter(context => context.state === "leased")).toHaveLength(2)
  })

  test("stale cleanup releases a matching lease without deleting checkout", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const checkout = path.join(runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    const registryFile = await writeRegistry(app, registryWithContext(checkout, {
      workerId: "builder-01",
      role: "builder",
      jobId: "task-a",
      mode: "code",
      leasedAt: "2026-04-25T00:00:00.000Z",
    }))
    await writeRun(runRecord(app, {context: {id: "ctx1", checkout, branch: "openteam/test"}}))

    const result = await stopRunRecord(app, "builder-01-task-a", "stale")
    const registry = JSON.parse(await readFile(registryFile, "utf8")) as RepoRegistry

    expect(result.releasedContext).toBe("ctx1")
    expect(registry.contexts.ctx1.state).toBe("idle")
    expect(registry.contexts.ctx1.lease).toBeUndefined()
    expect(existsSync(checkout)).toBe(true)
  })

  test("stale cleanup does not release a context leased by another run", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const checkout = path.join(runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    const registryFile = await writeRegistry(app, registryWithContext(checkout, {
      workerId: "builder-02",
      role: "builder",
      jobId: "task-b",
      mode: "code",
      leasedAt: "2026-04-25T00:00:00.000Z",
    }))
    await writeRun(runRecord(app, {context: {id: "ctx1", checkout, branch: "openteam/test"}}))

    const result = await stopRunRecord(app, "builder-01-task-a", "stale")
    const registry = JSON.parse(await readFile(registryFile, "utf8")) as RepoRegistry

    expect(result.releasedContext).toBeUndefined()
    expect(registry.contexts.ctx1.state).toBe("leased")
    expect(registry.contexts.ctx1.lease?.workerId).toBe("builder-02")
    expect(existsSync(checkout)).toBe(true)
  })

  test("run summaries report effective stale state instead of raw running", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const [summary] = await summarizeRuns(app, [{record: runRecord(app)}])

    expect(summary.state).toBe("stale")
    expect(summary.storedState).toBe("running")
    expect(summary.stale).toBe(true)
  })

  test("browser inspection does not report a dead dev URL as live", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const record = runRecord(app, {
      mode: "web",
      browser: {
        enabled: true,
        headless: false,
        profileDir: path.join(runtimeRoot, "profile"),
        artifactDir: path.join(runtimeRoot, "artifacts"),
        url: "http://127.0.0.1:9",
      },
      devServer: {url: "http://127.0.0.1:9"},
    })
    await writeRun(record)

    const stateFile = path.join(runtimeRoot, "agents", "builder-01", "state.json")
    await mkdir(path.dirname(stateFile), {recursive: true})
    await writeFile(stateFile, `${JSON.stringify({
      running: true,
      taskId: "task-a",
      runId: record.runId,
      mode: "web",
      url: "http://127.0.0.1:9",
    }, null, 2)}\n`)

    const info = await browserInspection(app, "builder")

    expect(info.storedRunning).toBe(true)
    expect(info.running).toBe(false)
    expect(info.liveWebRun).toBe(false)
    expect(info.stale).toBe(true)
  })

  test("worker agents do not accept operator DM control", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))

    expect(acceptsControlDms(app, "orchestrator-01")).toBe(true)
    expect(acceptsControlDms(app, "builder-01")).toBe(false)
  })

  test("provision mode blocks worker-control commands", () => {
    process.env.OPENTEAM_PHASE = "provision"

    expect(() => assertControlAllowed("launch")).toThrow("worker-control commands are disabled")
    expect(() => assertControlAllowed("work on repo")).toThrow("worker-control commands are disabled")
    expect(() => assertControlAllowed("repo")).not.toThrow()
  })

  test("provision logs detect recursive worker-control command attempts", () => {
    expect(provisionWorkerControlCommand("I will run: openteam launch triager --task test")).toBe("openteam launch")
    expect(provisionWorkerControlCommand("safe command: openteam repo policy")).toBeUndefined()
  })

  test("worker handoff requires a matching lease and checkout", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = path.join(runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    const app = makeApp(runtimeRoot)
    const agent = {
      app,
      id: "builder-01",
      configId: "builder-01",
      meta: {id: "builder-01", role: "builder", soul: "builder", repo: "app", description: "", capabilities: []},
      agent: app.config.agents["builder-01"],
      repo: app.config.repos.app,
      paths: {
        root: "",
        workspace: "",
        memory: "",
        tasks: "",
        queue: "",
        history: "",
        artifacts: "",
        browser: "",
        stateFile: "",
      },
    }
    const item = {id: "task-a", task: "test", createdAt: "", state: "queued", agentId: "builder-01"} satisfies TaskItem
    const resolved = {
      repo: app.config.repos.app,
      identity: {
        key: "30617:owner:repo",
        ownerPubkey: "owner",
        ownerNpub: "npub1owner",
        identifier: "repo",
        announcementEventId: "event",
        announcedAt: 1,
        relays: [],
        cloneUrls: [],
        rawTags: [],
      },
      context: {
        id: "ctx1",
        repoKey: "30617:owner:repo",
        path: path.dirname(checkout),
        checkout,
        mirror: "/tmp/mirror",
        mode: "code",
        baseRef: "HEAD",
        baseCommit: "abc123",
        branch: "openteam/test",
        state: "leased",
        lease: {
          workerId: "builder-01",
          role: "builder",
          jobId: "task-a",
          mode: "code",
          leasedAt: "2026-04-25T00:00:00.000Z",
        },
        createdAt: "2026-04-25T00:00:00.000Z",
        updatedAt: "2026-04-25T00:00:00.000Z",
      },
      target: "repo",
    } satisfies ResolvedRepoTarget

    expect(() => assertResolvedContextReady(resolved, agent, item)).not.toThrow()
    expect(() => assertResolvedContextReady({
      ...resolved,
      context: {...resolved.context, lease: {...resolved.context.lease!, jobId: "other-task"}},
    }, agent, item)).toThrow("lease does not match")
  })
})
