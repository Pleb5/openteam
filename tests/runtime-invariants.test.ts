import {afterEach, describe, expect, test} from "bun:test"
import {existsSync} from "node:fs"
import {mkdir, mkdtemp, readFile, writeFile} from "node:fs/promises"
import {spawnSync} from "node:child_process"
import {tmpdir} from "node:os"
import path from "node:path"
import {browserInspection} from "../src/commands/browser.js"
import {acceptsControlDms} from "../src/commands/profile.js"
import {cleanupStaleRunsForContext, runEvidenceView, stopRunRecord, summarizeRuns} from "../src/commands/runs.js"
import {statusReport} from "../src/commands/status.js"
import {verifyCommand} from "../src/commands/verify.js"
import {prepareAgent} from "../src/config.js"
import {assertControlAllowed} from "../src/control-guard.js"
import {detectDevEnv, wrapDevEnvCommand} from "../src/dev-env.js"
import {createDoneContract} from "../src/done-contract.js"
import {evaluateEvidencePolicy, prPublicationDecision} from "../src/evidence-policy.js"
import {configureCheckoutGitAuth, gitCredentialFromStdin} from "../src/git-auth.js"
import {
  assertResolvedContextReady,
  assertVerificationToolingReady,
  checkoutRuntimeEnv,
  provisionWorkerControlCommand,
  writeAgentBrowserTools,
  writeCheckoutToolShims,
} from "../src/launcher.js"
import {detectOpenCodeHardFailure, detectOpenCodeToolBoundaries, detectWorkerVerificationBlockers} from "../src/opencode-log.js"
import {detectProjectProfile, writeProjectProfile} from "../src/project-profile.js"
import {
  applyObservationReportPolicy,
  buildDueObservationDigest,
  emptyDmReportState,
  formatTaskRunReport,
} from "../src/reporting-policy.js"
import {resolveRepoTarget} from "../src/repo.js"
import {continuationEvidenceForCarry, continuationPromptLines, createContinuationTaskItem} from "../src/run-continuation.js"
import {observeRun, observeRuns} from "../src/run-observer.js"
import {executeOperatorTakeover, operatorTakeoverHandoffPath, releaseOperatorTakeover} from "../src/run-takeover.js"
import {refreshRuntimeStatus} from "../src/runtime-status.js"
import {resolveTaskSubject, subjectPromptLines} from "../src/subject.js"
import {
  appendVerificationResultsFile,
  createVerificationPlan,
  manualVerificationResult,
  readVerificationResults,
  resetVerificationResults,
  runLocalVerificationRunners,
  runVerificationRunner,
  verificationHasFailure,
  writeVerificationPlan,
} from "../src/verification.js"
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
  delete process.env.OPENTEAM_CHECKOUT
  delete process.env.OPENTEAM_RUN_FILE
  delete process.env.OPENTEAM_RUN_ID
  delete process.env.OPENTEAM_DEV_URL
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

  test("continuation cleanup releases stale holders for the requested context", async () => {
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

    const cleaned = await cleanupStaleRunsForContext(app, "ctx1")
    const registry = JSON.parse(await readFile(registryFile, "utf8")) as RepoRegistry

    expect(cleaned[0]?.runId).toBe("builder-01-task-a")
    expect(registry.contexts.ctx1.state).toBe("idle")
    expect(registry.contexts.ctx1.lease).toBeUndefined()
  })

  test("operator takeover writes redacted handoff and holds context", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const checkout = path.join(runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    const logFile = path.join(runtimeRoot, "prior-opencode.log")
    await writeFile(logFile, [
      "OPENTEAM_GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456",
      "Question: Should I continue?",
      "normal blocked context",
    ].join("\n"))
    const registryFile = await writeRegistry(app, registryWithContext(checkout, {
      workerId: "builder-01",
      role: "builder",
      jobId: "task-a",
      mode: "code",
      leasedAt: "2026-04-25T00:00:00.000Z",
    }))
    await writeRun(runRecord(app, {
      context: {id: "ctx1", checkout, branch: "openteam/test"},
      logs: {opencode: logFile},
    }))

    const result = await executeOperatorTakeover(app, "builder-01-task-a", {reason: "operator manual steering"})
    const record = JSON.parse(await readFile(path.join(runtimeRoot, "runs", "builder-01-task-a.json"), "utf8")) as TaskRunRecord
    const registry = JSON.parse(await readFile(registryFile, "utf8")) as RepoRegistry
    const handoff = await readFile(operatorTakeoverHandoffPath(checkout), "utf8")

    expect(result.handoffWritten).toBe(true)
    expect(result.contextHeld).toBe(true)
    expect(result.command).not.toContain("run")
    expect(result.command).not.toContain("--agent")
    expect(handoff).toContain("## Prior Discussion Summary")
    expect(handoff).toContain("normal blocked context")
    expect(handoff).toContain("[REDACTED")
    expect(handoff).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456")
    expect(record.state).toBe("interrupted")
    expect(record.failureCategory).toBe("operator-takeover")
    expect(record.manualTakeover?.contextHeld).toBe(true)
    expect(registry.contexts.ctx1.state).toBe("leased")
    expect(registry.contexts.ctx1.lease?.workerId).toBe("operator")
    expect(registry.contexts.ctx1.lease?.jobId).toBe("operator-takeover:builder-01-task-a")
  })

  test("operator takeover dry run does not mutate run or registry", async () => {
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

    const result = await executeOperatorTakeover(app, "builder-01-task-a", {dryRun: true})
    const record = JSON.parse(await readFile(path.join(runtimeRoot, "runs", "builder-01-task-a.json"), "utf8")) as TaskRunRecord
    const registry = JSON.parse(await readFile(registryFile, "utf8")) as RepoRegistry

    expect(result.dryRun).toBe(true)
    expect(existsSync(operatorTakeoverHandoffPath(checkout))).toBe(false)
    expect(record.state).toBe("running")
    expect(record.manualTakeover).toBeUndefined()
    expect(registry.contexts.ctx1.lease?.workerId).toBe("builder-01")
  })

  test("operator takeover release only releases matching operator hold", async () => {
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
    await executeOperatorTakeover(app, "builder-01-task-a")

    const result = await releaseOperatorTakeover(app, "builder-01-task-a")
    const record = JSON.parse(await readFile(path.join(runtimeRoot, "runs", "builder-01-task-a.json"), "utf8")) as TaskRunRecord
    const registry = JSON.parse(await readFile(registryFile, "utf8")) as RepoRegistry

    expect(result.released).toBe(true)
    expect(record.manualTakeover?.contextHeld).toBe(false)
    expect(record.manualTakeover?.releasedAt).toBeTruthy()
    expect(registry.contexts.ctx1.state).toBe("idle")
    expect(registry.contexts.ctx1.lease).toBeUndefined()
  })

  test("operator takeover refuses context leased by another run", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const checkout = path.join(runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    await writeRegistry(app, registryWithContext(checkout, {
      workerId: "builder-02",
      role: "builder",
      jobId: "task-b",
      mode: "code",
      leasedAt: "2026-04-25T00:00:00.000Z",
    }))
    await writeRun(runRecord(app, {
      state: "needs-review",
      process: {},
      phases: [{name: "opencode-worker", state: "succeeded"}],
      context: {id: "ctx1", checkout, branch: "openteam/test"},
    }))

    await expect(executeOperatorTakeover(app, "builder-01-task-a")).rejects.toThrow("already leased by builder-02/task-b")
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

  test("run summaries do not fail report-only runs for negative verification verdicts", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const [summary] = await summarizeRuns(app, [{
      record: runRecord(app, {
        role: "researcher",
        state: "succeeded",
        workerState: "succeeded",
        verificationState: "succeeded",
        doneContract: createDoneContract("researcher", "code", "Review dependency risk"),
        finishedAt: "2026-04-25T00:01:00.000Z",
        durationMs: 60_000,
        process: {},
        phases: [{name: "opencode-worker", state: "succeeded", startedAt: "2026-04-25T00:00:30.000Z"}],
        verification: {
          plan: createVerificationPlan(app, "code", {stacks: []}),
          results: [{
            id: "repo-native",
            kind: "command",
            state: "failed",
            source: "worker",
            note: "Reviewed package.json and lockfile; install fails; hand off dependency pinning to builder.",
          }],
        },
      }),
    }])

    expect(summary.state).toBe("succeeded")
    expect(summary.evidenceLevel).toBe("strong")
    expect(summary.staleReasons ?? []).not.toContain("verification runner failed: repo-native")
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

  test("done contracts classify task evidence expectations", () => {
    const contract = createDoneContract("builder", "web", "Fix the broken repo card light theme UI")

    expect(contract.taskClass).toBe("ui-web")
    expect(contract.requiredEvidence.join(" ")).toContain("browser")
    expect(contract.prPolicy).toContain("UI evidence")
  })

  test("run evidence view summarizes worker-produced evidence", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const record = runRecord(app, {
      state: "succeeded",
      workerState: "succeeded",
      doneContract: createDoneContract("builder", "web", "Fix browser UI bug"),
      verification: {
        plan: createVerificationPlan(app, "web", {stacks: ["web"]}),
        results: [
          {
            id: "browser",
            kind: "playwright-mcp",
            state: "succeeded",
            source: "worker",
            note: "Verified the UI flow in browser.",
            artifacts: [".openteam/artifacts/screenshot.png"],
          },
          {
            id: "repo-native",
            kind: "command",
            state: "succeeded",
            source: "worker",
            logFile: ".openteam/artifacts/verification/repo-native.log",
          },
        ],
      },
    })

    const evidence = runEvidenceView(record)

    expect(evidence.level).toBe("strong")
    expect(evidence.summary.succeeded).toBe(2)
    expect(evidence.artifacts).toContain(".openteam/artifacts/screenshot.png")
    expect(evidence.prPolicy).toContain("UI evidence")
    expect(evidence.prEligible).toBe(true)
  })

  test("builder success without verification evidence needs review and cannot publish PR", () => {
    const contract = createDoneContract("builder", "code", "Fix helper crash")
    const policy = evaluateEvidencePolicy(contract, [])
    const publication = prPublicationDecision(policy)

    expect(policy.level).toBe("none")
    expect(policy.finalStateForSuccessfulWorker).toBe("needs-review")
    expect(policy.prEligible).toBe(false)
    expect(publication.allowed).toBe(false)
    expect(policy.missingEvidence.length).toBeGreaterThan(0)
  })

  test("failed verification evidence blocks PR publication", () => {
    const contract = createDoneContract("builder", "code", "Fix helper crash")
    const policy = evaluateEvidencePolicy(contract, [{
      id: "repo-native",
      kind: "command",
      state: "failed",
      source: "worker",
      error: "cargo test failed",
    }])

    expect(policy.level).toBe("failed")
    expect(policy.finalStateForSuccessfulWorker).toBe("needs-review")
    expect(prPublicationDecision(policy).allowed).toBe(false)
  })

  test("strong builder evidence allows normal PR publication", () => {
    const contract = createDoneContract("builder", "code", "Fix helper crash")
    const policy = evaluateEvidencePolicy(contract, [
      {
        id: "repo-native",
        kind: "command",
        state: "succeeded",
        source: "worker",
        logFile: ".openteam/artifacts/verification/repo-native.log",
      },
      {
        id: "manual-behavior",
        kind: "command",
        state: "succeeded",
        source: "worker",
        note: "Reproduced the helper crash before the fix and verified the helper returns expected output after the fix.",
      },
    ])

    expect(policy.level).toBe("strong")
    expect(policy.finalStateForSuccessfulWorker).toBe("succeeded")
    expect(policy.prEligible).toBe(true)
    expect(prPublicationDecision(policy).allowed).toBe(true)
  })

  test("UI web work needs browser and repo-native evidence for normal PR publication", () => {
    const contract = createDoneContract("builder", "web", "Fix button colors")
    const browserOnly = evaluateEvidencePolicy(contract, [{
      id: "browser",
      kind: "playwright-mcp",
      state: "succeeded",
      source: "worker",
      note: "Verified button colors in browser.",
    }])
    const complete = evaluateEvidencePolicy(contract, [
      {
        id: "browser",
        kind: "playwright-mcp",
        state: "succeeded",
        source: "worker",
        note: "Verified button colors in browser.",
      },
      {
        id: "repo-native",
        kind: "command",
        state: "succeeded",
        source: "worker",
        logFile: ".openteam/artifacts/verification/repo-native.log",
      },
    ])

    expect(browserOnly.level).toBe("weak")
    expect(browserOnly.prEligible).toBe(false)
    expect(complete.level).toBe("strong")
    expect(complete.prEligible).toBe(true)
  })

  test("draft PR publication can be explicit when evidence is incomplete", () => {
    const contract = createDoneContract("builder", "code", "Start risky refactor")
    const policy = evaluateEvidencePolicy(contract, [])

    expect(prPublicationDecision(policy).allowed).toBe(false)
    expect(prPublicationDecision(policy, {draft: true}).allowed).toBe(true)
  })

  test("research evidence does not make normal PR publication eligible", () => {
    const contract = createDoneContract("researcher", "code", "Research a dependency upgrade")
    const policy = evaluateEvidencePolicy(contract, [{
      id: "research-note",
      kind: "command",
      state: "succeeded",
      source: "worker",
      note: "Inspected docs and events; recommended builder handoff.",
    }])

    expect(policy.level).toBe("strong")
    expect(policy.prEligible).toBe(false)
    expect(prPublicationDecision(policy).allowed).toBe(false)
  })

  test("research negative verification verdict can complete the report-only evidence contract", () => {
    const contract = createDoneContract("researcher", "code", "Review a dependency PR")
    const policy = evaluateEvidencePolicy(contract, [{
      id: "repo-native",
      kind: "command",
      state: "failed",
      evidenceType: "repo-native",
      source: "worker",
      note: "Question answered: the PR regresses install. Inspected package metadata and lockfile. Risk: mutable dependency tag and blocked build step. Handoff: builder should pin an immutable dependency artifact and document any required trust configuration.",
    }])

    expect(policy.level).toBe("strong")
    expect(policy.finalStateForSuccessfulWorker).toBe("succeeded")
    expect(policy.missingEvidence).toHaveLength(0)
    expect(policy.prEligible).toBe(false)
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

  test("run observer persists snapshots and emits state/evidence transitions", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const first = runRecord(app, {
      state: "needs-review",
      workerState: "succeeded",
      verificationState: "needs-review",
      failureCategory: "verification-evidence-missing",
      process: {},
      phases: [{name: "opencode-worker", state: "succeeded"}],
      doneContract: createDoneContract("builder", "code", "Fix helper crash"),
      verification: {
        plan: createVerificationPlan(app, "code", {stacks: []}),
        results: [],
      },
    })
    await writeRun(first)

    const initial = await observeRuns(app, {emitInitial: false})
    expect(initial.events).toHaveLength(0)
    expect(initial.state.runs[first.runId]?.state).toBe("needs-review")

    const second = {
      ...first,
      state: "succeeded" as const,
      verificationState: "succeeded" as const,
      failureCategory: undefined,
      verification: {
        ...first.verification!,
        results: [
          {
            id: "repo-native",
            kind: "command" as const,
            state: "succeeded" as const,
            evidenceType: "repo-native" as const,
            source: "worker" as const,
            logFile: ".openteam/artifacts/verification/repo-native.log",
          },
          {
            id: "manual-behavior",
            kind: "command" as const,
            state: "succeeded" as const,
            evidenceType: "manual" as const,
            source: "worker" as const,
            note: "Reproduced the helper crash and verified the fixed helper output.",
          },
        ],
      },
    }
    await writeRun(second)

    const observed = await observeRuns(app, {emitInitial: false})
    const fields = observed.events.flatMap(event => event.transitions.map(transition => transition.field))

    expect(fields).toContain("state")
    expect(fields).toContain("evidenceLevel")
    expect(fields).toContain("prEligible")
    expect(observed.state.runs[first.runId]?.state).toBe("succeeded")
    expect(observed.state.runs[first.runId]?.evidenceLevel).toBe("strong")
    expect(observed.state.runs[first.runId]?.prEligible).toBe(true)
  })

  test("run observer single-run snapshot exposes recommended action", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const record = runRecord(app, {
      state: "needs-review",
      workerState: "succeeded",
      verificationState: "needs-review",
      process: {},
      phases: [{name: "opencode-worker", state: "succeeded"}],
      doneContract: createDoneContract("builder", "web", "Fix light theme"),
      verification: {
        plan: createVerificationPlan(app, "web", {stacks: ["web"]}),
        results: [],
      },
    })
    await writeRun(record)

    const snapshot = await observeRun(app, record.runId)

    expect(snapshot.state).toBe("needs-review")
    expect(snapshot.evidenceLevel).toBe("none")
    expect(snapshot.prEligible).toBe(false)
    expect(snapshot.recommendedAction).toContain("continue")
  })

  test("DM task reports keep compact run metadata", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const record = runRecord(app, {
      state: "needs-review",
      workerState: "succeeded",
      verificationState: "needs-review",
      failureCategory: "verification-evidence-missing",
      target: "nostr://npub16p8v7varqwjes5hak6q7mz6pygqm4pwc6gve4mrned3xs8tz42gq7kfhdw/flotilla-budabit",
      mode: "web",
      task: "Fix checkout flow and verify the browser behavior",
      context: {
        id: "ctx1",
        checkout: path.join(runtimeRoot, "checkout"),
        branch: "openteam/test",
      },
    })

    const report = await formatTaskRunReport(record, {
      kind: "terminal",
      state: "needs-review",
      failureCategory: "verification-evidence-missing",
      evidenceLevel: "weak",
      prEligible: false,
      recommendedAction: "repair evidence",
    })

    expect(report).toContain("[builder-01] needs-review verification-evidence-missing")
    expect(report).toContain(`run: ${record.runId}`)
    expect(report).toContain(`family: ${record.runId}`)
    expect(report).toContain("target: nostr://npub")
    expect(report).toContain("/flotilla-budabit")
    expect(report).toContain("mode: web")
    expect(report).toContain("task: Fix checkout flow")
    expect(report).toContain("evidence: weak, PR no")
    expect(report).toContain(`next: openteam runs evidence ${record.runId}`)
  })

  test("DM observation policy suppresses duplicate terminal reports", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const record = runRecord(app, {
      state: "needs-review",
      workerState: "succeeded",
      verificationState: "needs-review",
      failureCategory: "verification-evidence-missing",
      process: {},
      phases: [{name: "opencode-worker", state: "succeeded"}],
      doneContract: createDoneContract("builder", "code", "Fix helper crash"),
      verification: {
        plan: createVerificationPlan(app, "code", {stacks: []}),
        results: [],
      },
    })
    await writeRun(record)
    const snapshot = await observeRun(app, record.runId)
    const event = {
      runId: record.runId,
      observedAt: snapshot.observedAt,
      snapshot,
      transitions: [{
        field: "state",
        from: "running",
        to: "needs-review",
        severity: "warning" as const,
        message: `${record.runId}: state changed from running to needs-review`,
      }],
    }
    const state = emptyDmReportState(app)

    const first = applyObservationReportPolicy(state, event, app.config.reporting)
    const repeat = applyObservationReportPolicy(state, event, app.config.reporting)

    expect(first.report).toContain(`run: ${record.runId}`)
    expect(first.report).toContain("evidence: none, PR no")
    expect(repeat.report).toBeUndefined()
    expect(state.runs[record.runId]?.reportCount).toBe(1)
  })

  test("DM digest mode groups warning observations without immediate spam", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    app.config.reporting.dmObservationMode = "digest"
    app.config.reporting.dmDigestIntervalMs = 0
    const record = runRecord(app, {
      state: "running",
      target: "30617:2cc86cc7b95121746fc8d00bb2e78ed1d4b1625aacbf34ced66e175e920bd65e:nostr-git-ui",
      mode: "web",
      process: {runnerPid: process.pid},
      phases: [{name: "start-dev-server", state: "running"}],
    })
    await writeRun(record)
    const snapshot = await observeRun(app, record.runId)
    const event = {
      runId: record.runId,
      observedAt: snapshot.observedAt,
      snapshot: {
        ...snapshot,
        state: "running",
        devHealthy: false,
        devError: "connection refused",
      },
      transitions: [{
        field: "devHealthy",
        from: true,
        to: false,
        severity: "warning" as const,
        message: `${record.runId}: devHealthy changed from true to false`,
      }],
    }
    const state = emptyDmReportState(app)

    const immediate = applyObservationReportPolicy(state, event, app.config.reporting)
    const digest = buildDueObservationDigest(state, app.config.reporting, {now: new Date("2026-04-27T00:00:00.000Z")})

    expect(immediate.report).toBeUndefined()
    expect(digest).toContain("openteam run digest")
    expect(digest).toContain("running: 1")
    expect(digest).toContain(`run=${record.runId}`)
  })

  test("continuation task reuses prior run context and carries evidence guidance", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const record = runRecord(app, {
      state: "needs-review",
      workerState: "succeeded",
      verificationState: "needs-review",
      mode: "web",
      context: {
        id: "ctx1",
        checkout: path.join(runtimeRoot, "repos", "contexts", "repo", "ctx1", "checkout"),
        branch: "openteam/test",
      },
      subject: {
        kind: "repo-pr-event",
        eventId: "5aaffa847ca00c7990b00f9566ca84643d2a27b23d68ea04ae8429cc2540dff0",
        path: "libs/nostr-git-ui",
        checkout: path.join(runtimeRoot, "repos", "contexts", "repo", "ctx1", "checkout", "libs", "nostr-git-ui"),
      },
      doneContract: createDoneContract("builder", "web", "Fix repo card light theme UI"),
      verification: {
        plan: createVerificationPlan(app, "web", {stacks: ["web"]}),
        results: [
          {
            id: "browser",
            kind: "playwright-mcp",
            state: "succeeded",
            evidenceType: "browser",
            source: "worker",
            note: "Verified visible card colors in browser.",
          },
          {
            id: "repo-native",
            kind: "command",
            state: "failed",
            evidenceType: "repo-native",
            source: "worker",
            error: "check failed before evidence repair",
          },
        ],
      },
    })

    const item = createContinuationTaskItem(record, {kind: "repair-evidence"})
    const noCarry = createContinuationTaskItem(record, {kind: "repair-evidence", carryEvidence: false})
    const prompt = continuationPromptLines(item.continuation)

    expect(item.agentId).toBe("builder-01")
    expect(item.mode).toBe("web")
    expect(item.subject?.path).toBe("libs/nostr-git-ui")
    expect(item.continuation?.contextId).toBe("ctx1")
    expect(item.continuation?.subject?.path).toBe("libs/nostr-git-ui")
    expect(item.continuation?.evidenceResults).toHaveLength(2)
    expect(continuationEvidenceForCarry(item.continuation)).toHaveLength(1)
    expect(noCarry.continuation?.evidenceResults).toHaveLength(2)
    expect(continuationEvidenceForCarry(noCarry.continuation)).toHaveLength(0)
    expect(item.task).toContain("repair the missing or weak verification evidence")
    expect(prompt.join(" ")).toContain("Prior missing evidence")
    expect(prompt.join(" ")).toContain("Prior review subject")
    expect(prompt.join(" ")).toContain("browser:succeeded")
    expect(prompt.join(" ")).toContain("repo-native:failed")
  })

  test("continuation drops raw model override after model infrastructure failure", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const record = runRecord(app, {
      model: "openai/retired-model",
      requestedModelProfile: "builder-default",
      failureCategory: "model-unavailable",
      context: {
        id: "ctx1",
        checkout: path.join(runtimeRoot, "checkout"),
        branch: "openteam/test",
      },
    })

    const item = createContinuationTaskItem(record, {kind: "retry"})

    expect(item.model).toBeUndefined()
    expect(item.modelProfile).toBe("builder-default")
  })

  test("continuation resolution leases the prior idle context without rediscovery", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const checkout = path.join(runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    const repoKey = `30617:${ownerPubkey}:repo`
    const registryFile = await writeRegistry(app, {
      version: 1,
      forks: {},
      repos: {
        [repoKey]: {
          key: repoKey,
          ownerPubkey,
          ownerNpub,
          identifier: "repo",
          announcementEventId: "event",
          announcedAt: 1,
          relays: [],
          cloneUrls: [],
          rawTags: [["d", "repo"]],
        },
      },
      contexts: {
        ctx1: {
          id: "ctx1",
          repoKey,
          path: path.dirname(checkout),
          checkout,
          mirror: "/tmp/mirror.git",
          mode: "code",
          baseRef: "HEAD",
          baseCommit: "abc123",
          branch: "openteam/test",
          state: "idle",
          createdAt: "2026-04-25T00:00:00.000Z",
          updatedAt: "2026-04-25T00:00:00.000Z",
        },
      },
    })
    const agent = await prepareAgent(app, "builder-01")
    const resolved = await resolveRepoTarget(app, agent, {
      id: "task-b",
      task: "continue",
      createdAt: "",
      state: "queued",
      agentId: "builder-01",
      target: "unresolvable-hint",
      mode: "code",
      continuation: {
        version: 1,
        kind: "continue",
        fromRunId: "builder-01-task-a",
        contextId: "ctx1",
        priorState: "needs-review",
        missingEvidence: [],
        prBlockers: [],
        carryEvidence: false,
        evidenceResults: [],
        createdAt: "2026-04-25T00:00:00.000Z",
      },
    })
    const registry = JSON.parse(await readFile(registryFile, "utf8")) as RepoRegistry

    expect(resolved.context.id).toBe("ctx1")
    expect(resolved.target).toBe("unresolvable-hint")
    expect(registry.contexts.ctx1.state).toBe("leased")
    expect(registry.contexts.ctx1.lease?.jobId).toBe("task-b")
    expect(registry.contexts.ctx1.lease?.workerId).toBe("builder-01")
  })

  test("continuation resolution refuses a busy prior context", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const checkout = path.join(runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    const repoKey = `30617:${ownerPubkey}:repo`
    await writeRegistry(app, {
      version: 1,
      forks: {},
      repos: {
        [repoKey]: {
          key: repoKey,
          ownerPubkey,
          ownerNpub,
          identifier: "repo",
          announcementEventId: "event",
          announcedAt: 1,
          relays: [],
          cloneUrls: [],
          rawTags: [["d", "repo"]],
        },
      },
      contexts: {
        ctx1: {
          id: "ctx1",
          repoKey,
          path: path.dirname(checkout),
          checkout,
          mirror: "/tmp/mirror.git",
          mode: "code",
          baseRef: "HEAD",
          baseCommit: "abc123",
          branch: "openteam/test",
          state: "leased",
          lease: {
            workerId: "builder-01",
            role: "builder",
            jobId: "active-task",
            mode: "code",
            leasedAt: "2026-04-25T00:00:00.000Z",
          },
          createdAt: "2026-04-25T00:00:00.000Z",
          updatedAt: "2026-04-25T00:00:00.000Z",
        },
      },
    })
    const agent = await prepareAgent(app, "builder-01")

    await expect(resolveRepoTarget(app, agent, {
      id: "task-b",
      task: "continue",
      createdAt: "",
      state: "queued",
      agentId: "builder-01",
      mode: "code",
      continuation: {
        version: 1,
        kind: "continue",
        fromRunId: "builder-01-task-a",
        contextId: "ctx1",
        priorState: "needs-review",
        missingEvidence: [],
        prBlockers: [],
        carryEvidence: false,
        evidenceResults: [],
        createdAt: "2026-04-25T00:00:00.000Z",
      },
    })).rejects.toThrow("is busy")
  })

  test("task subjects resolve to submodule paths inside the environment checkout", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = path.join(runtimeRoot, "parent-checkout")
    const childPath = "libs/nostr-git-ui"
    const childUrl = "https://github.com/budabit-agent-gh/nostr-git-ui.git"
    await mkdir(path.join(checkout, childPath), {recursive: true})
    await writeFile(path.join(checkout, ".gitmodules"), [
      `[submodule "${childPath}"]`,
      `\tpath = ${childPath}`,
      `\turl = ${childUrl}`,
      "",
    ].join("\n"))
    const app = makeApp(runtimeRoot)
    const parentKey = `30617:${ownerPubkey}:flotilla-budabit`
    const childKey = `30617:${ownerPubkey}:nostr-git-ui`
    await writeRegistry(app, {
      version: 1,
      forks: {},
      contexts: {},
      repos: {
        [parentKey]: {
          key: parentKey,
          ownerPubkey,
          ownerNpub,
          identifier: "flotilla-budabit",
          announcementEventId: "parent-event",
          announcedAt: 1,
          relays: ["wss://parent.example.com"],
          cloneUrls: [],
          rawTags: [["d", "flotilla-budabit"]],
        },
        [childKey]: {
          key: childKey,
          ownerPubkey,
          ownerNpub,
          identifier: "nostr-git-ui",
          announcementEventId: "child-event",
          announcedAt: 1,
          relays: ["wss://child.example.com"],
          cloneUrls: [childUrl],
          rawTags: [["d", "nostr-git-ui"], ["clone", childUrl]],
        },
      },
    })
    const agent = await prepareAgent(app, "builder-01")
    const environment: ResolvedRepoTarget = {
      repo: app.config.repos.app,
      identity: {
        key: parentKey,
        ownerPubkey,
        ownerNpub,
        identifier: "flotilla-budabit",
        announcementEventId: "parent-event",
        announcedAt: 1,
        relays: ["wss://parent.example.com"],
        cloneUrls: [],
        rawTags: [["d", "flotilla-budabit"]],
      },
      context: {
        id: "ctx-parent",
        repoKey: parentKey,
        path: runtimeRoot,
        checkout,
        mirror: "/tmp/mirror.git",
        mode: "code",
        baseRef: "HEAD",
        baseCommit: "abc123",
        branch: "openteam/test",
        state: "leased",
        createdAt: "2026-04-25T00:00:00.000Z",
        updatedAt: "2026-04-25T00:00:00.000Z",
      },
      target: "flotilla-budabit",
    }

    const subject = await resolveTaskSubject({
      app,
      agent,
      environment,
      checkout,
      subject: {
        kind: "repo-pr-event",
        eventId: "5aaffa847ca00c7990b00f9566ca84643d2a27b23d68ea04ae8429cc2540dff0",
        repoTarget: "nostr-git-ui",
      },
    })

    expect(subject.environmentCheckout).toBe(checkout)
    expect(subject.path).toBe(childPath)
    expect(subject.checkout).toBe(path.join(checkout, childPath))
    expect(subject.repo?.key).toBe(childKey)
    expect(subjectPromptLines(subject).join("\n")).toContain("Run provisioning, dependency installation, and verification from the environment checkout root")
  })

  test("task subject resolution fails before worker launch when the subject submodule is absent", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = path.join(runtimeRoot, "parent-checkout")
    await mkdir(checkout, {recursive: true})
    await writeFile(path.join(checkout, ".gitmodules"), [
      `[submodule "libs/other"]`,
      "\tpath = libs/other",
      "\turl = https://github.com/example/other.git",
      "",
    ].join("\n"))
    const app = makeApp(runtimeRoot)
    const parentKey = `30617:${ownerPubkey}:flotilla-budabit`
    const childKey = `30617:${ownerPubkey}:nostr-git-ui`
    await writeRegistry(app, {
      version: 1,
      forks: {},
      contexts: {},
      repos: {
        [childKey]: {
          key: childKey,
          ownerPubkey,
          ownerNpub,
          identifier: "nostr-git-ui",
          announcementEventId: "child-event",
          announcedAt: 1,
          relays: [],
          cloneUrls: ["https://github.com/budabit-agent-gh/nostr-git-ui.git"],
          rawTags: [["d", "nostr-git-ui"]],
        },
      },
    })
    const agent = await prepareAgent(app, "builder-01")
    const environment: ResolvedRepoTarget = {
      repo: app.config.repos.app,
      identity: {
        key: parentKey,
        ownerPubkey,
        ownerNpub,
        identifier: "flotilla-budabit",
        announcementEventId: "parent-event",
        announcedAt: 1,
        relays: [],
        cloneUrls: [],
        rawTags: [["d", "flotilla-budabit"]],
      },
      context: {
        id: "ctx-parent",
        repoKey: parentKey,
        path: runtimeRoot,
        checkout,
        mirror: "/tmp/mirror.git",
        mode: "code",
        baseRef: "HEAD",
        baseCommit: "abc123",
        branch: "openteam/test",
        state: "leased",
        createdAt: "2026-04-25T00:00:00.000Z",
        updatedAt: "2026-04-25T00:00:00.000Z",
      },
      target: "flotilla-budabit",
    }

    await expect(resolveTaskSubject({
      app,
      agent,
      environment,
      checkout,
      subject: {
        kind: "repo-pr-event",
        eventId: "5aaffa847ca00c7990b00f9566ca84643d2a27b23d68ea04ae8429cc2540dff0",
        repoTarget: "nostr-git-ui",
      },
    })).rejects.toThrow("not present as a submodule")
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
    const previous = process.env.OPENTEAM_PHASE
    process.env.OPENTEAM_PHASE = "provision"

    try {
      expect(() => assertControlAllowed("launch")).toThrow("worker-control commands are disabled")
      expect(() => assertControlAllowed("service")).toThrow("worker-control commands are disabled")
      expect(() => assertControlAllowed("work on repo")).toThrow("worker-control commands are disabled")
      expect(() => assertControlAllowed("repo")).not.toThrow()
      expect(() => assertControlAllowed("verify")).not.toThrow()
    } finally {
      if (previous === undefined) {
        delete process.env.OPENTEAM_PHASE
      } else {
        process.env.OPENTEAM_PHASE = previous
      }
    }
  })

  test("provision logs detect recursive worker-control command attempts", () => {
    expect(provisionWorkerControlCommand("I will run: openteam launch triager --task test")).toBe("openteam launch")
    expect(provisionWorkerControlCommand("safe command: openteam repo policy")).toBeUndefined()
  })

  test("OpenCode logs detect infrastructure hard failures", () => {
    expect(detectOpenCodeHardFailure('Error: {"type":"server_error","code":"server_error"}')?.reason).toContain("server_error")
    expect(detectOpenCodeHardFailure("Error: database is locked")?.category).toBe("opencode-database-locked")
    expect(detectOpenCodeHardFailure("Error: database is locked")?.retryable).toBe(true)
    expect(detectOpenCodeHardFailure("ProviderModelNotFoundError")?.category).toBe("model-unavailable")
    expect(detectOpenCodeHardFailure("Failed to fetch models.dev because the operation timed out")?.category).toBe("model-provider-unavailable")
    expect(detectOpenCodeHardFailure("! permission requested: external_directory (/tmp/*); auto-rejecting")?.reason).toContain("auto-rejected")
    expect(detectOpenCodeHardFailure("sandbox denied the requested command")?.reason).toContain("sandbox policy")
    expect(detectOpenCodeHardFailure("normal repo command failed with Error: test output")).toBeUndefined()
  })

  test("OpenCode logs detect tool registry boundaries", () => {
    expect(detectOpenCodeToolBoundaries([
      "INFO service=tool.registry status=started webfetch",
      "INFO service=tool.registry status=completed duration=0 grep",
    ].join("\n"))).toEqual([
      {tool: "webfetch", started: 1, completed: 0, inFlight: true},
      {tool: "grep", started: 0, completed: 1, inFlight: false},
    ])
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
      devDependencies: {
        electron: "latest",
      },
      packageManager: "pnpm@10.0.0",
    }))
    await mkdir(path.join(checkout, "src-tauri"), {recursive: true})
    await writeFile(path.join(checkout, "src-tauri", "tauri.conf.json"), "{}\n")
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
    expect(profile.stacks).toContain("desktop")
    expect(profile.stacks).toContain("electron")
    expect(profile.stacks).toContain("tauri")
    expect(profile.likelyCommands.some(item => item.command.join(" ") === "cargo check")).toBe(true)
    expect(profile.likelyCommands.some(item => item.command.join(" ") === "go test ./...")).toBe(true)
    expect(profile.likelyCommands.some(item => item.command.join(" ") === "pnpm run check")).toBe(true)
    expect(profile.guidance.join(" ")).toContain("override")
  })

  test("project profile flags standalone checkouts with workspace protocol dependencies", async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-checkout-"))
    await writeFile(path.join(checkout, "package.json"), JSON.stringify({
      scripts: {
        test: "vitest run",
      },
      dependencies: {
        "@nostr-git/core": "workspace:*",
      },
      packageManager: "pnpm@10.0.0",
    }))
    await writeFile(path.join(checkout, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")

    const profile = await detectProjectProfile(checkout, {kind: "none", commandPrefix: []})

    expect(profile.likelyCommands.some(item => item.command.join(" ") === "pnpm run test")).toBe(true)
    expect(profile.blockers.join(" ")).toContain("workspace: dependencies")
    expect(profile.blockers.join(" ")).toContain("containing workspace")
  })

  test("verification plan records local runners without executing them", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-checkout-"))
    const app = makeApp(runtimeRoot)

    const plan = createVerificationPlan(app, "web", {stacks: ["node", "web"]})
    const file = await writeVerificationPlan(checkout, plan)
    const saved = JSON.parse(await readFile(file, "utf8")) as typeof plan

    expect(plan.selectedRunnerIds).toContain("repo-native")
    expect(plan.selectedRunnerIds).toContain("agent-browser")
    expect(plan.selectedRunnerIds).toContain("browser")
    expect(plan.selectedRunnerIds.indexOf("agent-browser")).toBeLessThan(plan.selectedRunnerIds.indexOf("browser"))
    expect(plan.runners.find(runner => runner.id === "agent-browser")?.kind).toBe("browser-cli")
    expect(plan.runners.find(runner => runner.id === "agent-browser")?.configured).toBe(true)
    expect(plan.runners.find(runner => runner.id === "browser")?.kind).toBe("playwright-mcp")
    expect(plan.runners.find(runner => runner.id === "browser")?.configured).toBe(true)
    expect(saved.version).toBe(1)
    expect(saved.mode).toBe("web")
  })

  test("default browser-cli agent-browser runner maps to browser evidence", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-checkout-"))
    const app = makeApp(runtimeRoot)
    app.config.verification = {
      defaultRunners: {web: ["repo-native", "agent-browser", "browser"]},
      runners: {
        "agent-browser": {
          kind: "browser-cli",
          enabled: true,
          local: true,
          modes: ["web"],
          stacks: ["web"],
          command: [
            "sh",
            "-c",
            "test -d \"$OPENTEAM_AGENT_BROWSER_PROFILE_DIR\" && test \"$AGENT_BROWSER_EXECUTABLE_PATH\" = \"/usr/bin/chromium\" && test \"$OPENTEAM_AGENT_BROWSER_SESSION\" = \"openteam-run-123\" && printf \"$OPENTEAM_AGENT_BROWSER_SESSION\" > \"$OPENTEAM_AGENT_BROWSER_ARTIFACTS_DIR/session.txt\"",
          ],
          artifactsDir: ".openteam/artifacts/verification/agent-browser",
        },
      },
    }

    const plan = createVerificationPlan(app, "web", {stacks: ["web"]})
    const results = await runLocalVerificationRunners({checkout, plan, env: {OPENTEAM_RUN_ID: "run:123"}})
    const evidence = runEvidenceView(runRecord(app, {
      mode: "web",
      state: "succeeded",
      workerState: "succeeded",
      doneContract: createDoneContract("builder", "web", "Verify browser-cli evidence"),
      verification: {
        plan,
        results: [
          ...results,
          {
            id: "repo-native",
            kind: "command",
            state: "succeeded",
            evidenceType: "repo-native",
            source: "worker",
            logFile: ".openteam/artifacts/verification/repo-native.log",
          },
        ],
      },
    }))

    const agentBrowserResult = results.find(result => result.id === "agent-browser")

    expect(plan.selectedRunnerIds).toContain("agent-browser")
    expect(plan.runners.find(runner => runner.id === "agent-browser")?.kind).toBe("browser-cli")
    expect(agentBrowserResult?.state).toBe("succeeded")
    expect(agentBrowserResult?.evidenceType).toBe("browser")
    expect(agentBrowserResult?.artifacts).toContain(".openteam/artifacts/verification/agent-browser")
    expect(agentBrowserResult?.logFile).toContain(path.join(".openteam", "artifacts", "verification", "agent-browser"))
    expect(existsSync(path.join(checkout, ".openteam", "artifacts", "verification", "agent-browser", "profile"))).toBe(true)
    expect(await readFile(path.join(checkout, ".openteam", "artifacts", "verification", "agent-browser", "session.txt"), "utf8")).toBe("openteam-run-123")
    expect(evidence.groupSummary.browser).toBe(1)
    expect(evidence.level).toBe("strong")
  })

  test("local verification command runner writes structured results and logs", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-checkout-"))
    const app = makeApp(runtimeRoot)
    app.config.verification = {
      defaultRunners: {code: ["repo-native"]},
      runners: {
        "repo-native": {
          kind: "command",
          enabled: true,
          local: true,
          modes: ["code"],
          command: ["sh", "-c", "true"],
        },
      },
    }

    const plan = createVerificationPlan(app, "code", {stacks: []})
    const results = await runLocalVerificationRunners({checkout, plan})

    expect(results).toHaveLength(1)
    expect(results[0]?.state).toBe("succeeded")
    expect(results[0]?.logFile).toBeTruthy()
    expect(existsSync(results[0]!.logFile!)).toBe(true)
    expect(verificationHasFailure(results)).toBeUndefined()
  })

  test("local verification command failures are reported as run-blocking results", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-checkout-"))
    const app = makeApp(runtimeRoot)
    app.config.verification = {
      defaultRunners: {code: ["repo-native"]},
      runners: {
        "repo-native": {
          kind: "command",
          enabled: true,
          local: true,
          modes: ["code"],
          command: ["sh", "-c", "exit 7"],
        },
      },
    }

    const plan = createVerificationPlan(app, "code", {stacks: []})
    const results = await runLocalVerificationRunners({checkout, plan})

    expect(results[0]?.state).toBe("failed")
    expect(results[0]?.exitCode).toBe(7)
    expect(verificationHasFailure(results)?.id).toBe("repo-native")
  })

  test("worker-invoked verification runner appends evidence for orchestrator collection", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-checkout-"))
    const app = makeApp(runtimeRoot)
    app.config.verification = {
      autoRunAfterWorker: false,
      defaultRunners: {code: ["repo-native"]},
      runners: {
        "repo-native": {
          kind: "command",
          enabled: true,
          local: true,
          modes: ["code"],
          command: ["sh", "-c", "true"],
        },
      },
    }
    const plan = createVerificationPlan(app, "code", {stacks: []})
    await writeVerificationPlan(checkout, plan)

    const results = await runVerificationRunner({checkout, plan, runnerId: "repo-native", source: "worker"})
    await appendVerificationResultsFile(checkout, results)
    const saved = await readVerificationResults(checkout)

    expect(saved[0]?.id).toBe("repo-native")
    expect(saved[0]?.source).toBe("worker")
    expect(saved[0]?.state).toBe("succeeded")
  })

  test("managed checkout exposes openteam verify tooling before worker handoff", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-checkout-"))
    const app = makeApp(runtimeRoot)
    const plan = createVerificationPlan(app, "code", {stacks: []})

    await writeCheckoutToolShims(checkout, {kind: "none", commandPrefix: []}, app.root)
    await writeVerificationPlan(checkout, plan)
    await resetVerificationResults(checkout)

    const ready = await assertVerificationToolingReady(checkout)
    const shim = await readFile(ready.openteamShim, "utf8")

    expect(ready.openteamShim).toBe(path.join(checkout, ".openteam", "bin", "openteam"))
    expect(shim).toContain("OPENTEAM_CHECKOUT")
    expect(shim).toContain(path.join(app.root, "scripts", "openteam"))
  })

  test("verify browser preserves console evidence from artifact files", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-checkout-"))
    const app = makeApp(runtimeRoot)
    const consoleFile = path.join(checkout, "console.json")
    await writeVerificationPlan(checkout, createVerificationPlan(app, "web", {stacks: ["web"]}))
    await resetVerificationResults(checkout)
    await writeFile(consoleFile, JSON.stringify([{type: "error", text: "boom"}]))

    const originalLog = console.log
    console.log = () => undefined
    try {
      await verifyCommand(app, "browser", [
        "verify",
        "browser",
        "--checkout",
        checkout,
        "--flow",
        "console artifact",
        "--console-file",
        consoleFile,
      ])
    } finally {
      console.log = originalLog
    }

    const saved = await readVerificationResults(checkout)
    expect(saved[0]?.evidenceType).toBe("browser")
    expect(saved[0]?.consoleSummary).toBe('[{"type":"error","text":"boom"}]')
  })

  test("agent-browser OpenCode tools are generated by default for builders only", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-checkout-"))
    const app = makeApp(runtimeRoot)
    const agent = await prepareAgent(app, "builder-01", {runtimeId: "agent-browser-tools-test"})
    const toolFile = path.join(checkout, ".opencode", "tools", "agent_browser.ts")

    expect(await writeAgentBrowserTools(agent, checkout)).toBe(toolFile)
    expect(existsSync(toolFile)).toBe(true)

    app.config.browser.agentBrowserTools = {enabled: false}
    expect(await writeAgentBrowserTools(agent, checkout)).toBeUndefined()
    expect(existsSync(toolFile)).toBe(false)

    app.config.browser.agentBrowserTools = {
      enabled: true,
      command: "agent-browser",
      allowedDomains: ["127.0.0.1", "localhost", "app.example.test"],
      environment: {AGENT_BROWSER_MAX_OUTPUT: "50000"},
      maxOutputChars: 12345,
    }

    const written = await writeAgentBrowserTools(agent, checkout)
    const source = await readFile(toolFile, "utf8")

    expect(written).toBe(toolFile)
    expect(source).toContain("export const open = tool")
    expect(source).toContain("export const snapshot = tool")
    expect(source).toContain("export const press = tool")
    expect(source).toContain("export const type = tool")
    expect(source).toContain("export const find = tool")
    expect(source).toContain("export const scroll = tool")
    expect(source).toContain("export const select = tool")
    expect(source).toContain("export const check = tool")
    expect(source).toContain("export const uncheck = tool")
    expect(source).toContain("export const hover = tool")
    expect(source).toContain("export const record_evidence = tool")
    expect(source).toContain("--session")
    expect(source).toContain("sessionName()")
    expect(source).toContain("--allowed-domains")
    expect(source).toContain("--console-file")
    expect(source).not.toContain('"--all"')
    expect(source).not.toContain("args.all")
    expect(source).not.toContain("all: tool.schema")
    expect(source).not.toContain("Close all active")
    expect(source).toContain("AGENT_BROWSER_EXECUTABLE_PATH")
    expect(source).toContain("/usr/bin/chromium")
    expect(source).toContain("app.example.test")
    expect(source).toContain("MAX_OUTPUT_CHARS = 12345")
    expect(source).toContain("--max-output")
    expect(source).toContain("String(MAX_OUTPUT_CHARS)")
    expect(source).toContain("return run([\"press\"")
    expect(source).toContain("return run([\"type\"")
    expect(source).toContain("return run([\"find\"")
    expect(source).toContain("return run([\"scroll\"")
    expect(source).toContain("return run([\"select\"")
    expect(source).toContain("return run([\"check\"")
    expect(source).toContain("return run([\"uncheck\"")
    expect(source).toContain("return run([\"hover\"")
    expect(source).toContain(".openteam")

    const orchestrator = await prepareAgent(app, "orchestrator-01", {runtimeId: "agent-browser-tools-test-orchestrator"})
    expect(await writeAgentBrowserTools(orchestrator, checkout)).toBeUndefined()
    expect(existsSync(toolFile)).toBe(false)
  })

  test("verify command resolves checkout from worker runtime environment", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-checkout-"))
    const app = makeApp(runtimeRoot)
    await writeVerificationPlan(checkout, createVerificationPlan(app, "code", {stacks: []}))
    await resetVerificationResults(checkout)
    process.env.OPENTEAM_CHECKOUT = checkout

    const originalLog = console.log
    console.log = () => undefined
    try {
      await verifyCommand(app, "list", ["verify", "list"])
    } finally {
      console.log = originalLog
    }
  })

  test("verify command falls back to OPENTEAM_RUN_FILE checkout when cwd is unrelated", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-checkout-"))
    const app = makeApp(runtimeRoot)
    await writeVerificationPlan(checkout, createVerificationPlan(app, "code", {stacks: []}))
    await resetVerificationResults(checkout)
    const record = runRecord(app, {
      context: {
        id: "ctx1",
        checkout,
        branch: "openteam/test",
      },
    })
    await writeRun(record)
    process.env.OPENTEAM_RUN_FILE = record.runFile

    const originalLog = console.log
    console.log = () => undefined
    try {
      await verifyCommand(app, "list", ["verify", "list"])
    } finally {
      console.log = originalLog
    }
  })

  test("workers can record agentic verification evidence without running a command", async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-checkout-"))
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    const plan = createVerificationPlan(app, "web", {stacks: ["web"]})
    const runner = plan.runners.find(item => item.id === "browser")!

    const result = manualVerificationResult(runner, {
      state: "succeeded",
      note: "Verified login flow in browser with worker Nostr account.",
      artifacts: [".openteam/artifacts/playwright/session.json"],
    })
    await appendVerificationResultsFile(checkout, [result])
    const saved = await readVerificationResults(checkout)

    expect(saved[0]?.id).toBe("browser")
    expect(saved[0]?.state).toBe("succeeded")
    expect(saved[0]?.note).toContain("login flow")
  })

  test("verify browser records structured browser evidence", async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-checkout-"))
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    await writeVerificationPlan(checkout, createVerificationPlan(app, "web", {stacks: ["web"]}))

    const originalLog = console.log
    console.log = () => undefined
    try {
      await verifyCommand(app, "browser", [
        "verify",
        "browser",
        "--checkout",
        checkout,
        "--flow",
        "light theme repo grid",
        "--url",
        "http://127.0.0.1:18471/repos",
        "--screenshot",
        ".openteam/artifacts/playwright/light-theme.png",
        "--console",
        "No console errors during repo-grid inspection.",
        "--network",
        "No failed git metadata requests.",
      ])
    } finally {
      console.log = originalLog
    }
    const saved = await readVerificationResults(checkout)
    const record = runRecord(app, {
      state: "succeeded",
      workerState: "succeeded",
      doneContract: createDoneContract("builder", "web", "Fix light theme repo grid"),
      verification: {
        plan: createVerificationPlan(app, "web", {stacks: ["web"]}),
        results: [
          ...saved,
          {
            id: "repo-native",
            kind: "command",
            state: "succeeded",
            evidenceType: "repo-native",
            source: "worker",
            logFile: ".openteam/artifacts/verification/repo-native.log",
          },
        ],
      },
    })
    const evidence = runEvidenceView(record)

    expect(saved[0]?.id).toBe("browser")
    expect(saved[0]?.evidenceType).toBe("browser")
    expect(saved[0]?.flow).toBe("light theme repo grid")
    expect(saved[0]?.screenshots).toContain(".openteam/artifacts/playwright/light-theme.png")
    expect(evidence.groupSummary.browser).toBe(1)
    expect(evidence.level).toBe("strong")
    expect(evidence.prEligible).toBe(true)
  })

  test("verify artifact records structured Nostr event evidence", async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-checkout-"))
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    await writeVerificationPlan(checkout, createVerificationPlan(app, "code", {stacks: []}))

    const originalLog = console.log
    console.log = () => undefined
    try {
      await verifyCommand(app, "artifact", [
        "verify",
        "artifact",
        ".openteam/artifacts/nostr/comment.json",
        "--checkout",
        checkout,
        "--type",
        "nostr",
        "--runner",
        "repo-comment",
        "--event-id",
        "nevent1example",
        "--note",
        "Published repo-visible issue comment with repro verdict.",
      ])
    } finally {
      console.log = originalLog
    }
    const saved = await readVerificationResults(checkout)

    expect(saved[0]?.id).toBe("repo-comment")
    expect(saved[0]?.evidenceType).toBe("nostr")
    expect(saved[0]?.artifacts).toContain(".openteam/artifacts/nostr/comment.json")
    expect(saved[0]?.eventIds).toContain("nevent1example")
  })

  test("browser verification runner is explicit agentic evidence instead of a silent command", async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-checkout-"))
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    const plan = createVerificationPlan(app, "web", {stacks: ["web"]})

    const results = await runVerificationRunner({checkout, plan, runnerId: "browser", source: "worker"})

    expect(results[0]?.id).toBe("browser")
    expect(results[0]?.state).toBe("skipped")
    expect(results[0]?.skippedReason).toContain("verify record browser")
  })

  test("verification plan can surface explicit desktop runner capability", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    app.config.verification = {
      defaultRunners: {code: ["repo-native"]},
      runners: {
        "desktop-command": {
          kind: "desktop-command",
          enabled: true,
          local: true,
          modes: ["code"],
          stacks: ["desktop", "tauri"],
        },
      },
    }

    const plan = createVerificationPlan(app, "code", {stacks: ["tauri"]})

    expect(plan.selectedRunnerIds).toContain("repo-native")
    expect(plan.selectedRunnerIds).toContain("desktop-command")
    expect(plan.runners.find(runner => runner.id === "desktop-command")?.kind).toBe("desktop-command")
    expect(plan.runners.find(runner => runner.id === "desktop-command")?.configured).toBe(true)
  })

  test("guarded iOS verification blocks when local simulator capability is unavailable", async () => {
    if (process.platform === "darwin") return
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-checkout-"))
    const app = makeApp(runtimeRoot)
    app.config.verification = {
      defaultRunners: {code: ["ios-simulator"]},
      runners: {
        "ios-simulator": {
          kind: "ios-simulator",
          enabled: true,
          local: true,
          modes: ["code"],
          command: ["sh", "-c", "true"],
        },
      },
    }

    const plan = createVerificationPlan(app, "code", {stacks: ["ios"]})
    const results = await runLocalVerificationRunners({checkout, plan})

    expect(results[0]?.state).toBe("blocked")
    expect(results[0]?.blocker).toContain("macOS")
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
    expect(env.OPENTEAM_CHECKOUT).toBe("/repo/checkout")
    expect(env.npm_config_cache).toBe("/repo/checkout/.openteam/cache/npm")
    expect(env.PATH?.split(":")[0]).toBe("/repo/checkout/.openteam/bin")
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
