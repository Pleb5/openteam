import {afterEach, describe, expect, test} from "bun:test"
import {existsSync} from "node:fs"
import {mkdir, mkdtemp, readFile, writeFile} from "node:fs/promises"
import {spawnSync} from "node:child_process"
import {tmpdir} from "node:os"
import path from "node:path"
import {browserInspection} from "../src/commands/browser.js"
import {acceptsControlDms} from "../src/commands/profile.js"
import {stopRunRecord, summarizeRuns} from "../src/commands/runs.js"
import {statusReport} from "../src/commands/status.js"
import {prepareAgent} from "../src/config.js"
import {assertControlAllowed} from "../src/control-guard.js"
import {detectDevEnv, wrapDevEnvCommand} from "../src/dev-env.js"
import {configureCheckoutGitAuth, gitCredentialFromStdin} from "../src/git-auth.js"
import {assertResolvedContextReady, checkoutRuntimeEnv, provisionWorkerControlCommand} from "../src/launcher.js"
import {detectOpenCodeHardFailure, detectWorkerVerificationBlockers} from "../src/opencode-log.js"
import {detectProjectProfile, writeProjectProfile} from "../src/project-profile.js"
import {resolveRepoTarget} from "../src/repo.js"
import {refreshRuntimeStatus} from "../src/runtime-status.js"
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

  test("run summaries report OpenCode hard-failure logs as effective failed state", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const logFile = path.join(runtimeRoot, "agents", "builder-01", "artifacts", "worker.log")
    await mkdir(path.dirname(logFile), {recursive: true})
    await writeFile(logFile, 'Error: {"type":"server_error","code":"server_error"}\n')
    const [summary] = await summarizeRuns(app, [{
      record: runRecord(app, {
        state: "succeeded",
        finishedAt: "2026-04-25T00:01:00.000Z",
        durationMs: 60_000,
        process: {},
        phases: [{name: "opencode-worker", state: "succeeded", startedAt: "2026-04-25T00:00:00.000Z"}],
        logs: {opencode: logFile},
      }),
    }])

    expect(summary.state).toBe("failed")
    expect(summary.storedState).toBe("succeeded")
    expect(summary.stale).toBe(false)
    expect(summary.staleReasons?.[0]).toContain("OpenCode log contains hard failure")
  })

  test("run summaries report failed verification as effective failed state", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const [summary] = await summarizeRuns(app, [{
      record: runRecord(app, {
        state: "succeeded",
        workerState: "succeeded",
        verificationState: "failed",
        failureCategory: "dev-server-unhealthy",
        finishedAt: "2026-04-25T00:01:00.000Z",
        durationMs: 60_000,
        process: {},
        phases: [{name: "verify-dev-server", state: "failed", startedAt: "2026-04-25T00:00:30.000Z"}],
      }),
    }])

    expect(summary.state).toBe("failed")
    expect(summary.storedState).toBe("succeeded")
    expect(summary.workerState).toBe("succeeded")
    expect(summary.verificationState).toBe("failed")
    expect(summary.failureCategory).toBe("dev-server-unhealthy")
    expect(summary.staleReasons?.[0]).toContain("verification failed")
  })

  test("run summaries preserve recovered dev-server verification success", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const [summary] = await summarizeRuns(app, [{
      record: runRecord(app, {
        state: "succeeded",
        workerState: "succeeded",
        verificationState: "succeeded",
        finishedAt: "2026-04-25T00:01:00.000Z",
        durationMs: 60_000,
        process: {},
        devServer: {
          restartCount: 1,
          restartedAt: "2026-04-25T00:00:50.000Z",
        },
        phases: [
          {name: "verify-dev-server", state: "failed", startedAt: "2026-04-25T00:00:30.000Z"},
          {name: "restart-dev-server", state: "succeeded", startedAt: "2026-04-25T00:00:45.000Z"},
          {name: "verify-dev-server-after-restart", state: "succeeded", startedAt: "2026-04-25T00:00:50.000Z"},
        ],
      }),
    }])

    expect(summary.state).toBe("succeeded")
    expect(summary.storedState).toBeUndefined()
    expect(summary.workerState).toBe("succeeded")
    expect(summary.verificationState).toBe("succeeded")
    expect(summary.failureCategory).toBeUndefined()
  })

  test("runtime status file records stale leases and cleanup metadata", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const checkout = path.join(runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    await writeRegistry(app, registryWithContext(checkout, {
      workerId: "builder-01",
      role: "builder",
      jobId: "task-a",
      mode: "code",
      leasedAt: "2026-04-25T00:00:00.000Z",
    }))

    const status = await refreshRuntimeStatus(app, {
      lastCleanupDryRunAt: "2026-04-25T01:00:00.000Z",
      lastCleanupCount: 1,
    })
    const saved = JSON.parse(await readFile(status.statusFile, "utf8")) as typeof status

    expect(existsSync(status.statusFile)).toBe(true)
    expect(saved.leases.leased).toBe(1)
    expect(saved.leases.stale).toBe(1)
    expect(saved.leases.staleContexts[0]?.id).toBe("ctx1")
    expect(saved.cleanup.lastCleanupDryRunAt).toBe("2026-04-25T01:00:00.000Z")
    expect(saved.cleanup.lastCleanupCount).toBe(1)
  })

  test("operator status reports stale leases and writes runtime status", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const checkout = path.join(runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    await writeRegistry(app, registryWithContext(checkout, {
      workerId: "builder-01",
      role: "builder",
      jobId: "task-a",
      mode: "code",
      leasedAt: "2026-04-25T00:00:00.000Z",
    }))

    const report = await statusReport(app)

    expect(report.summary.staleLeases).toBe(1)
    expect(report.summary.leasedContexts).toBe(1)
    expect(report.runtimeStatus.leases.staleContexts[0]?.reason).toContain("no live running run matches lease")
    expect(existsSync(report.summary.statusFile)).toBe(true)
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

  test("browser inspection exposes worker and verification state", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const record = runRecord(app, {
      mode: "web",
      state: "succeeded",
      workerState: "succeeded",
      verificationState: "failed",
      failureCategory: "dev-server-unhealthy",
      finishedAt: "2026-04-25T00:01:00.000Z",
      durationMs: 60_000,
      process: {},
      browser: {
        enabled: true,
        headless: false,
        profileDir: path.join(runtimeRoot, "profile"),
        artifactDir: path.join(runtimeRoot, "artifacts"),
        url: "http://127.0.0.1:9",
      },
      devServer: {
        url: "http://127.0.0.1:9",
        healthChecks: 4,
        healthFailures: 2,
        restartCount: 1,
        restartedAt: "2026-04-25T00:00:50.000Z",
      },
      phases: [{name: "verify-dev-server", state: "failed", startedAt: "2026-04-25T00:00:30.000Z"}],
    })
    await writeRun(record)

    const stateFile = path.join(runtimeRoot, "agents", "builder-01", "state.json")
    await mkdir(path.dirname(stateFile), {recursive: true})
    await writeFile(stateFile, `${JSON.stringify({
      running: false,
      taskId: "task-a",
      runId: record.runId,
      mode: "web",
      url: "http://127.0.0.1:9",
    }, null, 2)}\n`)

    const info = await browserInspection(app, "builder")

    expect(info.runState).toBe("failed")
    expect(info.storedRunState).toBe("succeeded")
    expect(info.workerState).toBe("succeeded")
    expect(info.verificationState).toBe("failed")
    expect(info.failureCategory).toBe("dev-server-unhealthy")
    expect(info.devServer.restartCount).toBe(1)
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

  test("OpenCode logs detect infrastructure hard failures", () => {
    expect(detectOpenCodeHardFailure('Error: {"type":"server_error","code":"server_error"}')?.reason).toContain("server_error")
    expect(detectOpenCodeHardFailure("! permission requested: external_directory (/tmp/*); auto-rejecting")?.reason).toContain("auto-rejected")
    expect(detectOpenCodeHardFailure("sandbox denied the requested command")?.reason).toContain("sandbox policy")
    expect(detectOpenCodeHardFailure("normal repo command failed with Error: test output")).toBeUndefined()
  })

  test("worker logs detect verification blockers without classifying normal errors", () => {
    expect(detectWorkerVerificationBlockers("Playwright Chromium exited with SIGTRAP")).toHaveLength(2)
    expect(detectOpenCodeHardFailure("Publication is still blocked by the environment")?.reason).toContain("publication")
    expect(detectWorkerVerificationBlockers("gitlint: command not found").at(0)?.reason).toContain("gitlint")
    expect(detectWorkerVerificationBlockers("To get started with GitHub CLI, please run: gh auth login").at(0)?.reason).toContain("GitHub CLI")
    expect(detectWorkerVerificationBlockers("npm ERR! code EOVERRIDE override conflict").at(0)?.reason).toContain("override")
    expect(detectWorkerVerificationBlockers("check script exited with code 127").at(0)?.reason).toContain("executable")
    expect(detectWorkerVerificationBlockers("unit test failed because assertion mismatch")).toHaveLength(0)
  })

  test("detects Nix dev environments and wraps commands", async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-checkout-"))
    await writeFile(path.join(checkout, ".envrc"), "use flake\n")
    await writeFile(path.join(checkout, "flake.nix"), "{}\n")

    const devEnv = await detectDevEnv(checkout)
    expect(devEnv.kind).toBe("nix-flake")
    expect(devEnv.source).toBe(".envrc")
    expect(wrapDevEnvCommand(devEnv, "cargo", ["clippy", "--all-targets"])).toEqual({
      cmd: "nix",
      args: ["develop", "--command", "cargo", "clippy", "--all-targets"],
    })
  })

  test("project profile records hints without overriding repo policy", async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-checkout-"))
    await writeFile(path.join(checkout, "README.md"), "# Test\n")
    await writeFile(path.join(checkout, "Cargo.toml"), "[package]\nname = \"test\"\nversion = \"0.1.0\"\n")
    await writeFile(path.join(checkout, "go.mod"), "module example.com/test\n")
    await writeFile(path.join(checkout, "package.json"), JSON.stringify({
      scripts: {
        check: "tsc --noEmit",
        build: "vite build",
      },
      packageManager: "pnpm@10.0.0",
    }))
    await writeFile(path.join(checkout, "flake.nix"), "{}\n")

    const devEnv = await detectDevEnv(checkout)
    const profile = await detectProjectProfile(checkout, devEnv)
    const file = await writeProjectProfile(checkout, profile)

    expect(file).toBe(path.join(checkout, ".openteam", "project-profile.json"))
    expect(profile.declaredEnvironment.kind).toBe("nix-flake")
    expect(profile.docs).toContain("README.md")
    expect(profile.stacks).toContain("rust")
    expect(profile.stacks).toContain("go")
    expect(profile.stacks).toContain("node")
    expect(profile.likelyCommands.some(item => item.command.join(" ") === "cargo check")).toBe(true)
    expect(profile.likelyCommands.some(item => item.command.join(" ") === "go test ./...")).toBe(true)
    expect(profile.likelyCommands.some(item => item.command.join(" ") === "pnpm run check")).toBe(true)
    expect(profile.guidance.join(" ")).toContain("override")
  })

  test("detects legacy nix-shell environments", async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-checkout-"))
    await writeFile(path.join(checkout, "shell.nix"), "{}\n")

    const devEnv = await detectDevEnv(checkout)
    expect(devEnv.kind).toBe("nix-shell")
    expect(devEnv.source).toBe("shell.nix")
    expect(wrapDevEnvCommand(devEnv, "git", ["commit", "-m", "fix: test"])).toEqual({
      cmd: "nix-shell",
      args: ["--run", "'git' 'commit' '-m' 'fix: test'"],
    })
  })

  test("worker process env confines temp and cache paths to checkout runtime dirs", () => {
    const env = checkoutRuntimeEnv("/repo/checkout", {OPENTEAM_PHASE: "provision"})

    expect(env.TMPDIR).toBe("/repo/checkout/.openteam/tmp")
    expect(env.TMP).toBe("/repo/checkout/.openteam/tmp")
    expect(env.TEMP).toBe("/repo/checkout/.openteam/tmp")
    expect(env.XDG_CACHE_HOME).toBe("/repo/checkout/.openteam/cache")
    expect(env.OPENTEAM_ARTIFACTS_DIR).toBe("/repo/checkout/.openteam/artifacts")
    expect(env.npm_config_cache).toBe("/repo/checkout/.openteam/cache/npm")
    expect(env.OPENTEAM_PHASE).toBe("provision")
  })

  test("managed checkout git credentials resolve provider token for matching fork URL only", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    app.config.providers["github.com"].token = "openteam-gh-token"
    const checkout = path.join(runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})

    const auth = await configureCheckoutGitAuth(app, checkout, ["https://github.com/budabit-agent-gh/ngit.git"], "budabit-agent-gh")
    expect(auth?.contextFile).toBe(path.join(checkout, ".openteam", "git-credential-context.json"))

    const credential = await gitCredentialFromStdin(app, ["--context", auth!.contextFile, "get"], [
      "protocol=https",
      "host=github.com",
      "path=budabit-agent-gh/ngit.git",
      "",
    ].join("\n"))

    expect(credential).toContain("username=budabit-agent-gh")
    expect(credential).toContain("password=openteam-gh-token")

    const rejected = await gitCredentialFromStdin(app, ["--context", auth!.contextFile, "get"], [
      "protocol=https",
      "host=github.com",
      "path=Pleb5/ngit.git",
      "",
    ].join("\n"))

    expect(rejected).toBe("")
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
