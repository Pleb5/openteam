import {afterEach, describe, expect, test} from "bun:test"
import {existsSync} from "node:fs"
import {spawnSync} from "node:child_process"
import {mkdir, mkdtemp, readFile, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {getPublicKey, nip19} from "nostr-tools"
import {statusReport} from "../src/commands/status.js"
import {
  cleanupStaleRunsForContext,
  diagnoseRun,
  recentRunRecords,
  runEvidenceView,
  stopRunRecord,
  summarizeRuns,
} from "../src/commands/runs.js"
import {assertControlAllowed} from "../src/control-guard.js"
import {prepareAgent} from "../src/config.js"
import {detectDevEnv, wrapDevEnvCommand} from "../src/dev-env.js"
import {createDoneContract} from "../src/done-contract.js"
import {evaluateEvidencePolicy, groupEvidenceResults, prPublicationDecision} from "../src/evidence-policy.js"
import {
  assertVerificationToolingReady,
  categorizeProvisioningFailure,
  checkoutRuntimeEnv,
  defaultRepoPublishScope,
  provisionWorkerControlCommand,
  writeCheckoutToolShims,
} from "../src/launcher.js"
import {parseOperatorRequest, dispatchOperatorRequest} from "../src/orchestrator.js"
import {detectProjectProfile} from "../src/project-profile.js"
import {
  deriveForkClonePlan,
  deriveForkCloneUrl,
  forkEventTags,
  parseRepoReference,
  releaseRepoContext,
  repoIdentityFromAnnouncement,
  resolveRepoRelayPolicy,
  resolveRepoTarget,
} from "../src/repo.js"
import {
  applyObservationReportPolicy,
  buildDueObservationDigest,
  emptyDmReportState,
  formatTaskRunReport,
  resolveRunFamilyKey,
} from "../src/reporting-policy.js"
import {
  continuationEvidenceForCarry,
  continuationPromptLines,
  createContinuationTaskItem,
} from "../src/run-continuation.js"
import {
  evaluateContinuationGate,
  readRunFamilyState,
  recordContinuationLaunch,
  writeContinuationHandoff,
  writeRunFamilyState,
} from "../src/run-family-policy.js"
import {observeRun, observeRuns, type RunObservationEvent, type RunObservationSnapshot} from "../src/run-observer.js"
import {refreshRuntimeStatus} from "../src/runtime-status.js"
import {
  appendVerificationResultsFile,
  createVerificationPlan,
  manualVerificationResult,
  readVerificationResults,
  resetVerificationResults,
  runLocalVerificationRunners,
  runVerificationRunner,
  verificationPlanSummary,
  writeVerificationPlan,
} from "../src/verification.js"
import type {
  AppCfg,
  RepoContext,
  RepoIdentity,
  RepoRegistry,
  TaskRunRecord,
} from "../src/types.js"

const sec = "1111111111111111111111111111111111111111111111111111111111111111"
const ownerPubkey = getPublicKey(new Uint8Array(Buffer.from(sec, "hex")))
const ownerNpub = nip19.npubEncode(ownerPubkey)
const upstreamPubkey = getPublicKey(new Uint8Array(Buffer.from("2222222222222222222222222222222222222222222222222222222222222222", "hex")))
const upstreamNpub = nip19.npubEncode(upstreamPubkey)

const repoKey = (pubkey: string, identifier: string) => `30617:${pubkey}:${identifier}`

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
      headless: true,
      executablePath: "/usr/bin/chromium",
      mcp: {name: "playwright", command: ["bunx", "@playwright/mcp@latest"], environment: {}},
    },
    providers: {},
    repos: {
      app: {
        root: process.cwd(),
        baseBranch: "master",
        sharedPaths: [],
        mode: "code",
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
      "triager-01": {
        role: "triager",
        soul: "triager",
        repo: "app",
        portStart: 18472,
        reporting: {},
        identity: {npub: "", sec, bunkerProfile: "triager-01", nakClientKey: ""},
        nostr_git: {},
      },
      "qa-01": {
        role: "qa",
        soul: "qa",
        repo: "app",
        portStart: 18473,
        reporting: {},
        identity: {npub: "", sec, bunkerProfile: "qa-01", nakClientKey: ""},
        nostr_git: {},
      },
      "researcher-01": {
        role: "researcher",
        soul: "researcher",
        repo: "app",
        portStart: 18474,
        reporting: {},
        identity: {npub: "", sec, bunkerProfile: "researcher-01", nakClientKey: ""},
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

const identity = (patch: Partial<RepoIdentity> = {}): RepoIdentity => {
  const identifier = patch.identifier ?? "repo"
  const pubkey = patch.ownerPubkey ?? ownerPubkey
  return {
    key: patch.key ?? repoKey(pubkey, identifier),
    ownerPubkey: pubkey,
    ownerNpub: patch.ownerNpub ?? nip19.npubEncode(pubkey),
    identifier,
    announcementEventId: patch.announcementEventId ?? "event-id",
    announcedAt: patch.announcedAt ?? 1,
    relays: patch.relays ?? [],
    cloneUrls: patch.cloneUrls ?? [],
    name: patch.name,
    defaultBranch: patch.defaultBranch,
    sourceHint: patch.sourceHint,
    rawTags: patch.rawTags ?? [["d", identifier]],
  }
}

const writeRegistry = async (app: AppCfg, registry: RepoRegistry) => {
  const file = path.join(app.config.runtimeRoot, "repos", "registry.json")
  await mkdir(path.dirname(file), {recursive: true})
  await writeFile(file, `${JSON.stringify(registry, null, 2)}\n`)
  return file
}

const registryWith = (repo: RepoIdentity, contexts: Record<string, RepoContext> = {}): RepoRegistry => ({
  version: 1,
  repos: {[repo.key]: repo},
  forks: {},
  contexts,
})

const initRepo = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openteam-e2e-repo-"))
  runGit(root, ["init"])
  runGit(root, ["config", "user.email", "test@example.com"])
  runGit(root, ["config", "user.name", "Test User"])
  await writeFile(path.join(root, "README.md"), "test\n")
  runGit(root, ["add", "README.md"])
  runGit(root, ["commit", "-m", "initial"])
  return root
}

const appWithSeededRepo = async (identifier = "repo") => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
  const app = makeApp(runtimeRoot)
  const root = await initRepo()
  const repo = identity({identifier, cloneUrls: [root], rawTags: [["d", identifier], ["clone", root]]})
  await writeRegistry(app, registryWith(repo))
  return {app, root, repo}
}

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
    task: patch.task ?? "Fix checkout flow and verify it",
    target: patch.target ?? "repo",
    mode: patch.mode ?? "code",
    state: patch.state ?? "running",
    startedAt: patch.startedAt ?? new Date().toISOString(),
    process: patch.process ?? {runnerPid: 999999999},
    phases: patch.phases ?? [{name: "opencode-worker", state: "running", startedAt: new Date().toISOString()}],
    ...patch,
  }
}

const writeRun = async (record: TaskRunRecord) => {
  await mkdir(path.dirname(record.runFile), {recursive: true})
  await writeFile(record.runFile, `${JSON.stringify(record, null, 2)}\n`)
}

const leasedContext = (checkout: string, patch: Partial<RepoContext> = {}): RepoContext => ({
  id: patch.id ?? "ctx1",
  repoKey: patch.repoKey ?? repoKey(ownerPubkey, "repo"),
  path: patch.path ?? path.dirname(checkout),
  checkout,
  mirror: patch.mirror ?? "/tmp/mirror.git",
  mode: patch.mode ?? "code",
  baseRef: patch.baseRef ?? "HEAD",
  baseCommit: patch.baseCommit ?? "abc123",
  branch: patch.branch ?? "openteam/test",
  state: patch.state ?? "leased",
  lease: patch.lease ?? {
    workerId: "builder-01",
    role: "builder",
    jobId: "task-a",
    mode: "code",
    leasedAt: "2026-04-25T00:00:00.000Z",
  },
  createdAt: patch.createdAt ?? "2026-04-25T00:00:00.000Z",
  updatedAt: patch.updatedAt ?? "2026-04-25T00:00:00.000Z",
  ...patch,
})

const observationEvent = (
  snapshot: RunObservationSnapshot,
  field: string,
  from: unknown,
  to: unknown,
  severity: "info" | "warning" | "critical",
): RunObservationEvent => ({
  runId: snapshot.runId,
  observedAt: snapshot.observedAt,
  snapshot,
  transitions: [{
    field,
    from,
    to,
    severity,
    message: `${snapshot.runId}: ${field} changed from ${String(from)} to ${String(to)}`,
  }],
})

afterEach(() => {
  delete process.env.OPENTEAM_PHASE
  delete process.env.OPENTEAM_CHECKOUT
  delete process.env.OPENTEAM_RUN_FILE
})

describe("Round 1 - repo identity and fork planning", () => {
  test("parses canonical repo references with npub owners", () => {
    expect(parseRepoReference(`30617:${upstreamNpub}:flotilla-budabit`)).toEqual({
      ownerPubkey: upstreamPubkey,
      identifier: "flotilla-budabit",
      relays: [],
    })
  })

  test("parses npub path repo references", () => {
    expect(parseRepoReference(`${upstreamNpub}/flotilla-budabit`)).toEqual({
      ownerPubkey: upstreamPubkey,
      identifier: "flotilla-budabit",
      relays: [],
    })
  })

  test("builds repo identities from content clone URL fallback", () => {
    const repo = repoIdentityFromAnnouncement({
      id: "event-id",
      pubkey: upstreamPubkey,
      created_at: 10,
      tags: [["d", "repo"]],
      content: "clone https://git.example.com/upstream/repo.git",
    })

    expect(repo?.cloneUrls).toEqual(["https://git.example.com/upstream/repo.git"])
  })

  test("ignores announcements that lack a d tag", () => {
    expect(repoIdentityFromAnnouncement({
      id: "event-id",
      pubkey: upstreamPubkey,
      created_at: 10,
      tags: [["clone", "https://git.example.com/repo.git"]],
      content: "",
    })).toBeUndefined()
  })

  test("normalizes and deduplicates repo relay policy inputs", () => {
    const app = makeApp("/tmp/openteam-runtime")
    app.config.nostr_git.repoAnnouncementRelays = ["wss://repo.example.com/"]
    const repo = identity({
      relays: ["repo.example.com", "wss://extra.example.com/"],
      cloneUrls: ["https://git.example.com/repo.git"],
      rawTags: [
        ["d", "repo"],
        ["clone", "https://git.example.com/repo.git"],
        ["relays", "repo.example.com", "wss://extra.example.com/"],
      ],
    })

    expect(resolveRepoRelayPolicy(app, repo).repoRelays).toEqual([
      "wss://repo.example.com",
      "wss://extra.example.com",
    ])
  })

  test("includes relay hints from direct nostr targets in non-GRASP policy", () => {
    const app = makeApp("/tmp/openteam-runtime")
    app.config.nostr_git.repoAnnouncementRelays = []
    const target = `nostr://${upstreamNpub}/relay-hint.example.com/repo`
    const repo = identity({
      ownerPubkey: upstreamPubkey,
      ownerNpub: upstreamNpub,
      cloneUrls: ["https://git.example.com/upstream/repo.git"],
      rawTags: [["d", "repo"], ["clone", "https://git.example.com/upstream/repo.git"]],
    })

    expect(resolveRepoRelayPolicy(app, repo, {target}).repoRelays).toContain("wss://relay-hint.example.com")
  })

  test("expands fork clone templates with fork owner and repo prefix", () => {
    const app = makeApp("/tmp/openteam-runtime")
    app.config.nostr_git.forkGitOwner = "openteam"
    app.config.nostr_git.forkRepoPrefix = "ot-"
    app.config.nostr_git.forkCloneUrlTemplate = "https://git.example.com/{forkOwner}/{forkRepo}.git"

    expect(deriveForkCloneUrl(
      app,
      identity({ownerPubkey: upstreamPubkey, ownerNpub: upstreamNpub, identifier: "repo"}),
      "https://git.example.com/upstream/repo.git",
      {npub: ownerNpub, pubkey: ownerPubkey},
    )).toBe("https://git.example.com/openteam/ot-repo.git")
  })

  test("rejects non-smart-http upstream clone URLs for fork creation", () => {
    expect(() => deriveForkClonePlan(
      makeApp("/tmp/openteam-runtime"),
      identity({ownerPubkey: upstreamPubkey, ownerNpub: upstreamNpub}),
      "git@git.example.com:upstream/repo.git",
      {npub: ownerNpub, pubkey: ownerPubkey},
    )).toThrow("Git smart HTTP")
  })

  test("fork announcement tags preserve upstream linkage and default branch", () => {
    const repo = identity({
      ownerPubkey: upstreamPubkey,
      ownerNpub: upstreamNpub,
      defaultBranch: "main",
      rawTags: [["d", "repo"], ["clone", "https://git.example.com/upstream/repo.git"]],
    })

    const tags = forkEventTags(makeApp("/tmp/openteam-runtime"), repo, ["https://git.example.com/openteam/repo.git"], "https://git.example.com/upstream/repo.git")

    expect(tags).toContainEqual(["a", repo.key])
    expect(tags).toContainEqual(["fork", repo.key])
    expect(tags).toContainEqual(["upstream", repo.key])
    expect(tags).toContainEqual(["HEAD", "main"])
  })
})

describe("Round 2 - repo context leasing and provisioning handoff", () => {
  test("defaults fork-backed publication to the upstream repo for local work", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    const upstream = identity({
      key: repoKey(upstreamPubkey, "repo"),
      ownerPubkey: upstreamPubkey,
      ownerNpub: upstreamNpub,
      cloneUrls: ["https://git.example.com/upstream/repo.git"],
    })
    const fork = identity({cloneUrls: ["https://git.example.com/openteam/repo.git"]})
    const resolved = {
      repo: app.config.repos.app,
      identity: fork,
      upstreamIdentity: upstream,
      context: leasedContext(app.config.runtimeRoot, {repoKey: fork.key}),
      target: "repo",
    }

    expect(defaultRepoPublishScope(resolved)).toBe("upstream")
    expect(defaultRepoPublishScope({...resolved, upstreamIdentity: undefined})).toBe("repo")
  })

  test("resolves a cached Nostr repo into a leased checkout", async () => {
    const {app} = await appWithSeededRepo()
    const agent = await prepareAgent(app, "builder-01")

    const resolved = await resolveRepoTarget(app, agent, {
      id: "task-a",
      task: "first",
      createdAt: "",
      state: "queued",
      agentId: "builder-01",
      target: "repo",
      mode: "code",
    })

    expect(resolved.context.state).toBe("leased")
    expect(resolved.context.lease?.jobId).toBe("task-a")
    expect(existsSync(resolved.context.checkout)).toBe(true)
  })

  test("reuses an idle same-commit context for serial work", async () => {
    const {app} = await appWithSeededRepo()
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
    await releaseRepoContext(app, first.context.id, {workerId: "builder-01", jobId: "task-a"})

    const second = await resolveRepoTarget(app, agent, {
      id: "task-b",
      task: "second",
      createdAt: "",
      state: "queued",
      agentId: "builder-01",
      target: "repo",
      mode: "code",
    })

    expect(second.context.id).toBe(first.context.id)
    expect(second.context.lease?.jobId).toBe("task-b")
  })

  test("explicit parallel work creates a separate context even when an idle context exists", async () => {
    const {app} = await appWithSeededRepo()
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
    await releaseRepoContext(app, first.context.id, {workerId: "builder-01", jobId: "task-a"})

    const parallel = await resolveRepoTarget(app, agent, {
      id: "task-b",
      task: "parallel",
      createdAt: "",
      state: "queued",
      agentId: "builder-01",
      target: "repo",
      mode: "code",
      parallel: true,
    })

    expect(parallel.context.id).not.toBe(first.context.id)
    expect(parallel.context.lease?.parallel).toBe(true)
  })

  test("active leased contexts block serial work on the same repo", async () => {
    const {app} = await appWithSeededRepo()
    const agent = await prepareAgent(app, "builder-01")
    await resolveRepoTarget(app, agent, {
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
  })

  test("resolves an orchestrator fork key with its upstream context", async () => {
    const {app, root} = await appWithSeededRepo()
    const agent = await prepareAgent(app, "builder-01")
    const upstream = identity({
      key: repoKey(upstreamPubkey, "repo"),
      ownerPubkey: upstreamPubkey,
      ownerNpub: upstreamNpub,
      cloneUrls: [root],
      rawTags: [["d", "repo"], ["clone", root]],
    })
    const fork = identity({cloneUrls: [root], sourceHint: "fork-target", rawTags: [["d", "repo"], ["clone", root]]})
    await writeRegistry(app, {
      version: 1,
      repos: {[upstream.key]: upstream, [fork.key]: fork},
      forks: {
        [upstream.key]: {
          upstreamKey: upstream.key,
          forkKey: fork.key,
          ownerPubkey: fork.ownerPubkey,
          ownerNpub: fork.ownerNpub,
          forkIdentifier: fork.identifier,
          forkAnnouncementEventId: fork.announcementEventId,
          upstreamCloneUrl: root,
          forkCloneUrl: root,
          forkCloneUrls: [root],
          provider: "announced",
          createdAt: "2026-04-25T00:00:00.000Z",
          updatedAt: "2026-04-25T00:00:00.000Z",
        },
      },
      contexts: {},
    })

    const resolved = await resolveRepoTarget(app, agent, {
      id: "task-fork-key",
      task: "fix from fork key",
      createdAt: "",
      state: "queued",
      agentId: "builder-01",
      target: "fork-target",
      mode: "code",
    })

    expect(resolved.identity.key).toBe(fork.key)
    expect(resolved.upstreamIdentity?.key).toBe(upstream.key)
    expect(resolved.context.upstreamRepoKey).toBe(upstream.key)
    expect(defaultRepoPublishScope(resolved)).toBe("upstream")
  })

  test("different requested mode does not reuse an otherwise idle context", async () => {
    const {app} = await appWithSeededRepo()
    app.config.repos.app.mode = "web"
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
    await releaseRepoContext(app, first.context.id, {workerId: "builder-01", jobId: "task-a"})

    const second = await resolveRepoTarget(app, agent, {
      id: "task-b",
      task: "web task",
      createdAt: "",
      state: "queued",
      agentId: "builder-01",
      target: "repo",
      mode: "web",
    })

    expect(second.context.id).not.toBe(first.context.id)
    expect(second.context.mode).toBe("web")
  })

  test("continuation fails early when its prior context is absent", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    await writeRegistry(app, {version: 1, repos: {}, forks: {}, contexts: {}})
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
        fromRunId: "missing",
        contextId: "ctx-missing",
        priorState: "needs-review",
        missingEvidence: [],
        prBlockers: [],
        carryEvidence: false,
        evidenceResults: [],
        createdAt: "",
      },
    })).rejects.toThrow("continuation context not found")
  })

  test("continuation fails early when its checkout disappeared", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const repo = identity()
    await writeRegistry(app, registryWith(repo, {
      ctx1: leasedContext(path.join(runtimeRoot, "missing-checkout"), {
        state: "idle",
        lease: undefined,
        repoKey: repo.key,
      }),
    }))
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
        createdAt: "",
      },
    })).rejects.toThrow("checkout is missing")
  })

  test("continuation refuses a mode mismatch before worker handoff", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = path.join(runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    const app = makeApp(runtimeRoot)
    const repo = identity()
    await writeRegistry(app, registryWith(repo, {
      ctx1: leasedContext(checkout, {
        state: "idle",
        lease: undefined,
        repoKey: repo.key,
        mode: "web",
      }),
    }))
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
        createdAt: "",
      },
    })).rejects.toThrow("was created for web mode")
  })

  test("continuation restores upstream context for legacy fork-only contexts", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = path.join(runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    const app = makeApp(runtimeRoot)
    const upstream = identity({
      key: repoKey(upstreamPubkey, "repo"),
      ownerPubkey: upstreamPubkey,
      ownerNpub: upstreamNpub,
      cloneUrls: [checkout],
    })
    const fork = identity({cloneUrls: [checkout]})
    await writeRegistry(app, {
      version: 1,
      repos: {[upstream.key]: upstream, [fork.key]: fork},
      forks: {
        [upstream.key]: {
          upstreamKey: upstream.key,
          forkKey: fork.key,
          ownerPubkey: fork.ownerPubkey,
          ownerNpub: fork.ownerNpub,
          forkIdentifier: fork.identifier,
          forkAnnouncementEventId: fork.announcementEventId,
          upstreamCloneUrl: checkout,
          forkCloneUrl: checkout,
          forkCloneUrls: [checkout],
          provider: "announced",
          createdAt: "2026-04-25T00:00:00.000Z",
          updatedAt: "2026-04-25T00:00:00.000Z",
        },
      },
      contexts: {
        ctx1: leasedContext(checkout, {
          state: "idle",
          lease: undefined,
          repoKey: fork.key,
          upstreamRepoKey: undefined,
        }),
      },
    })
    const agent = await prepareAgent(app, "builder-01")

    const resolved = await resolveRepoTarget(app, agent, {
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
        createdAt: "",
      },
    })

    expect(resolved.identity.key).toBe(fork.key)
    expect(resolved.upstreamIdentity?.key).toBe(upstream.key)
    expect(resolved.context.upstreamRepoKey).toBe(upstream.key)
    expect(defaultRepoPublishScope(resolved)).toBe("upstream")
  })
})

describe("Round 3 - provisioning guardrails and checkout runtime", () => {
  test("provision mode blocks launch commands", () => {
    process.env.OPENTEAM_PHASE = "provision"

    expect(() => assertControlAllowed("launch")).toThrow("worker-control commands are disabled")
  })

  test("provision mode blocks unknown control commands", () => {
    process.env.OPENTEAM_PHASE = "provision"

    expect(() => assertControlAllowed("start")).toThrow("worker-control commands are disabled")
  })

  test("provision mode allows repo, verify, status, and runs inspection commands", () => {
    process.env.OPENTEAM_PHASE = "provision"

    expect(() => assertControlAllowed("repo")).not.toThrow()
    expect(() => assertControlAllowed("verify")).not.toThrow()
    expect(() => assertControlAllowed("status")).not.toThrow()
    expect(() => assertControlAllowed("runs")).not.toThrow()
  })

  test("provision log scanner catches bun CLI worker launches", () => {
    expect(provisionWorkerControlCommand("bun run src/cli.ts launch builder --task test")).toBe("bun run src/cli.ts launch")
  })

  test("provision log scanner catches script worker commands", () => {
    expect(provisionWorkerControlCommand("scripts/openteam worker start builder")).toContain("openteam worker")
  })

  test("provision log scanner allows repo-policy inspection", () => {
    expect(provisionWorkerControlCommand("openteam repo policy --target repo")).toBeUndefined()
  })

  test("checkout runtime env confines temp, cache, and artifacts to checkout", () => {
    const env = checkoutRuntimeEnv("/work/repo", {OPENTEAM_PHASE: "provision"})

    expect(env.TMPDIR).toBe("/work/repo/.openteam/tmp")
    expect(env.XDG_CACHE_HOME).toBe("/work/repo/.openteam/cache")
    expect(env.OPENTEAM_ARTIFACTS_DIR).toBe("/work/repo/.openteam/artifacts")
    expect(env.PATH?.split(":")[0]).toBe("/work/repo/.openteam/bin")
    expect(env.OPENTEAM_PHASE).toBe("provision")
  })

  test("checkout shims and verification files are present before worker handoff", async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-checkout-"))
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    await writeCheckoutToolShims(checkout, {kind: "none", commandPrefix: []}, app.root)
    await writeVerificationPlan(checkout, createVerificationPlan(app, "code", {stacks: []}))
    await resetVerificationResults(checkout)

    const ready = await assertVerificationToolingReady(checkout)

    expect(ready.openteamShim).toBe(path.join(checkout, ".openteam", "bin", "openteam"))
    expect(ready.verificationPlan).toBe(path.join(checkout, ".openteam", "verification-plan.json"))
  })
})

describe("Round 4 - run diagnosis and stale cleanup", () => {
  test("running records without pids are diagnosed stale", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    const diagnosis = await diagnoseRun(app, runRecord(app, {process: {}}))

    expect(diagnosis.stale).toBe(true)
    expect(diagnosis.reasons.join(" ")).toContain("no recorded process pids")
  })

  test("running records with only dead pids are diagnosed stale", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    const diagnosis = await diagnoseRun(app, runRecord(app, {process: {runnerPid: 999999999}}))

    expect(diagnosis.stale).toBe(true)
    expect(diagnosis.reasons.join(" ")).toContain("all recorded process pids are dead")
  })

  test("running records with a live runner pid are not stale without a browser URL", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    const diagnosis = await diagnoseRun(app, runRecord(app, {process: {runnerPid: process.pid}}))

    expect(diagnosis.stale).toBe(false)
    expect(diagnosis.anyPidAlive).toBe(true)
  })

  test("summaries turn succeeded OpenCode hard failures into effective failed state", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const logFile = path.join(runtimeRoot, "worker.log")
    await writeFile(logFile, 'Error: {"type":"server_error","code":"server_error"}\n')
    const [summary] = await summarizeRuns(app, [{
      record: runRecord(app, {
        state: "succeeded",
        process: {},
        logs: {opencode: logFile},
        phases: [{name: "opencode-worker", state: "succeeded"}],
      }),
    }])

    expect(summary.state).toBe("failed")
    expect(summary.storedState).toBe("succeeded")
  })

  test("summaries turn needs-review OpenCode model failures into effective failed state", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const logFile = path.join(runtimeRoot, "worker.log")
    await writeFile(logFile, "ProviderModelNotFoundError: Model not found: openai/gpt-5.5\n")
    const [summary] = await summarizeRuns(app, [{
      record: runRecord(app, {
        state: "needs-review",
        workerState: "succeeded",
        verificationState: "needs-review",
        failureCategory: "verification-evidence-missing",
        process: {},
        logs: {opencode: logFile},
        phases: [{name: "opencode-worker", state: "succeeded"}],
      }),
    }])

    expect(summary.state).toBe("failed")
    expect(summary.storedState).toBe("needs-review")
    expect(summary.failureCategory).toBe("model-unavailable")
    expect(summary.staleReasons?.join(" ")).toContain("OpenCode log contains hard failure")
  })

  test("summaries turn needs-review OpenCode database locks into retryable failed state", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = path.join(runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    const app = makeApp(runtimeRoot)
    const logFile = path.join(runtimeRoot, "worker.log")
    await writeFile(logFile, "Error: database is locked\n")
    const [summary] = await summarizeRuns(app, [{
      record: runRecord(app, {
        state: "needs-review",
        workerState: "succeeded",
        verificationState: "needs-review",
        process: {},
        context: {id: "ctx1", checkout, branch: "openteam/test"},
        logs: {opencode: logFile},
        phases: [{name: "opencode-worker", state: "succeeded"}],
      }),
    }])

    expect(summary.state).toBe("failed")
    expect(summary.storedState).toBe("needs-review")
    expect(summary.failureCategory).toBe("opencode-database-locked")
    expect(summary.recommendedAction).toBe("openteam runs retry builder-01-task-a")
  })

  test("diagnose reports stopped dev servers as stopped after healthy run", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const diagnosis = await diagnoseRun(app, runRecord(app, {
      state: "succeeded",
      process: {},
      devServer: {
        url: "http://127.0.0.1:9",
        startedAt: "2026-04-25T00:00:00.000Z",
        stoppedAt: "2026-04-25T00:01:00.000Z",
        lastHealthOkAt: "2026-04-25T00:00:30.000Z",
      },
      phases: [{name: "stop-dev-server", state: "succeeded"}],
    }))

    expect(diagnosis.devServer.status).toBe("stopped after healthy run")
    expect(diagnosis.devServer.health.ok).toBe(false)
  })

  test("finished runs with matching leased contexts produce cleanup reasons", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = path.join(runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    const app = makeApp(runtimeRoot)
    await writeRegistry(app, registryWith(identity(), {ctx1: leasedContext(checkout)}))

    const diagnosis = await diagnoseRun(app, runRecord(app, {
      state: "succeeded",
      process: {},
      context: {id: "ctx1", checkout, branch: "openteam/test"},
      phases: [{name: "opencode-worker", state: "succeeded"}],
    }))

    expect(diagnosis.reasons.join(" ")).toContain("repo context is still leased after run finished")
  })

  test("terminal worker logs surface verification blockers", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const logFile = path.join(runtimeRoot, "worker.log")
    await writeFile(logFile, "To get started with GitHub CLI, please run: gh auth login\n")

    const diagnosis = await diagnoseRun(app, runRecord(app, {
      state: "failed",
      process: {},
      logs: {opencode: logFile},
      phases: [{name: "opencode-worker", state: "failed"}],
    }))

    expect(diagnosis.reasons.join(" ")).toContain("worker log contains verification blockers")
  })

  test("stale cleanup releases matching leases and marks the run stale", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = path.join(runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    const app = makeApp(runtimeRoot)
    await writeRegistry(app, registryWith(identity(), {ctx1: leasedContext(checkout)}))
    await writeRun(runRecord(app, {context: {id: "ctx1", checkout, branch: "openteam/test"}}))

    const [cleaned] = await cleanupStaleRunsForContext(app, "ctx1")

    expect(cleaned?.runId).toBe("builder-01-task-a")
    expect(cleaned?.releasedContext).toBe("ctx1")
  })

  test("cleanup leaves contexts alone when the expected lease does not match", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = path.join(runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    const app = makeApp(runtimeRoot)
    await writeRegistry(app, registryWith(identity(), {
      ctx1: leasedContext(checkout, {
        lease: {
          workerId: "builder-02",
          role: "builder",
          jobId: "task-b",
          mode: "code",
          leasedAt: "2026-04-25T00:00:00.000Z",
        },
      }),
    }))
    await writeRun(runRecord(app, {context: {id: "ctx1", checkout, branch: "openteam/test"}}))

    const stopped = await stopRunRecord(app, "builder-01-task-a", "stale")

    expect(stopped.releasedContext).toBeUndefined()
  })
})

describe("Round 5 - evidence gates and publication decisions", () => {
  test("bug-fix command evidence with logs is strong", () => {
    const policy = evaluateEvidencePolicy(createDoneContract("builder", "code", "Fix crash"), [{
      id: "repo-native",
      kind: "command",
      state: "succeeded",
      source: "worker",
      logFile: ".openteam/artifacts/verification/repo-native.log",
    }])

    expect(policy.level).toBe("strong")
    expect(policy.prEligible).toBe(true)
  })

  test("bug-fix command evidence without substantive artifact stays weak", () => {
    const policy = evaluateEvidencePolicy(createDoneContract("builder", "code", "Fix crash"), [{
      id: "repo-native",
      kind: "command",
      state: "succeeded",
      source: "worker",
    }])

    expect(policy.level).toBe("weak")
    expect(policy.prEligible).toBe(false)
  })

  test("failed verification blocks normal PR publication", () => {
    const policy = evaluateEvidencePolicy(createDoneContract("builder", "code", "Fix crash"), [{
      id: "repo-native",
      kind: "command",
      state: "failed",
      source: "worker",
      error: "tests failed",
    }])

    expect(policy.level).toBe("failed")
    expect(prPublicationDecision(policy).allowed).toBe(false)
  })

  test("blocked verification remains needs-review even when the worker finished", () => {
    const policy = evaluateEvidencePolicy(createDoneContract("builder", "web", "Fix UI"), [{
      id: "browser",
      kind: "playwright-mcp",
      state: "blocked",
      source: "worker",
      blocker: "browser unavailable",
    }])

    expect(policy.level).toBe("blocked")
    expect(policy.finalStateForSuccessfulWorker).toBe("needs-review")
  })

  test("qa negative verdicts can satisfy report-only evidence contracts", () => {
    const policy = evaluateEvidencePolicy(createDoneContract("qa", "code", "Review install failure"), [{
      id: "repo-native",
      kind: "command",
      state: "failed",
      source: "worker",
      note: "Verdict: fail. Reproduced install failure and recorded expected handoff.",
    }])

    expect(policy.level).toBe("strong")
    expect(policy.finalStateForSuccessfulWorker).toBe("succeeded")
    expect(policy.prEligible).toBe(false)
  })

  test("evidence grouping classifies Nostr event artifacts", () => {
    const groups = groupEvidenceResults([{
      id: "repo-comment",
      kind: "command",
      state: "succeeded",
      source: "worker",
      eventIds: ["nevent1example"],
    }])

    expect(groups.nostr).toHaveLength(1)
  })

  test("draft publication can be explicit while normal publication remains blocked", () => {
    const policy = evaluateEvidencePolicy(createDoneContract("builder", "code", "Start refactor"), [])

    expect(prPublicationDecision(policy).allowed).toBe(false)
    expect(prPublicationDecision(policy, {draft: true}).allowed).toBe(true)
  })

  test("run evidence view exposes missing UI evidence and PR blockers", () => {
    const app = makeApp("/tmp/openteam-runtime")
    const view = runEvidenceView(runRecord(app, {
      state: "needs-review",
      doneContract: createDoneContract("builder", "web", "Fix theme"),
      verification: {
        plan: createVerificationPlan(app, "web", {stacks: ["web"]}),
        results: [{
          id: "repo-native",
          kind: "command",
          state: "succeeded",
          source: "worker",
          logFile: ".openteam/artifacts/verification/repo-native.log",
        }],
      },
    }))

    expect(view.level).toBe("weak")
    expect(view.prEligible).toBe(false)
    expect(view.missingEvidence.join(" ").toLowerCase()).toContain("browser")
  })
})

describe("Round 6 - observations and DM reporting policy", () => {
  test("initial observation emits an event when requested", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    const record = runRecord(app, {state: "needs-review", process: {}, phases: [{name: "opencode-worker", state: "succeeded"}]})
    await writeRun(record)

    const observed = await observeRuns(app, {emitInitial: true})

    expect(observed.events[0]?.transitions[0]?.field).toBe("observed")
  })

  test("observation state records evidence transitions from none to strong", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    const base = runRecord(app, {
      state: "needs-review",
      process: {},
      doneContract: createDoneContract("builder", "code", "Fix crash"),
      verification: {plan: createVerificationPlan(app, "code", {stacks: []}), results: []},
      phases: [{name: "opencode-worker", state: "succeeded"}],
    })
    await writeRun(base)
    await observeRuns(app, {emitInitial: false})
    await writeRun({
      ...base,
      state: "succeeded",
      verification: {
        ...base.verification!,
        results: [{
          id: "repo-native",
          kind: "command",
          state: "succeeded",
          source: "worker",
          logFile: ".openteam/artifacts/verification/repo-native.log",
        }],
      },
    })

    const observed = await observeRuns(app, {emitInitial: false})

    expect(observed.events[0]?.transitions.map(item => item.field)).toContain("evidenceLevel")
  })

  test("needs-review observation filter includes runs with no evidence", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    await writeRun(runRecord(app, {
      state: "needs-review",
      process: {},
      doneContract: createDoneContract("builder", "code", "Fix crash"),
      verification: {plan: createVerificationPlan(app, "code", {stacks: []}), results: []},
      phases: [{name: "opencode-worker", state: "succeeded"}],
    }))

    const observed = await observeRuns(app, {filter: "needs-review"})

    expect(observed.snapshots).toHaveLength(1)
  })

  test("DM policy suppresses repeated needs-review reports in the same family", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    const parent = runRecord(app, {
      runId: "builder-01-root",
      state: "needs-review",
      failureCategory: "verification-evidence-missing",
      process: {},
      context: {id: "ctx1", checkout: "/tmp/checkout", branch: "openteam/test"},
      phases: [{name: "opencode-worker", state: "succeeded"}],
    })
    const child = runRecord(app, {
      runId: "builder-01-child",
      state: "needs-review",
      failureCategory: "verification-evidence-missing",
      process: {},
      context: {id: "ctx1", checkout: "/tmp/checkout", branch: "openteam/test"},
      continuation: {
        version: 1,
        kind: "repair-evidence",
        fromRunId: parent.runId,
        fromRunFile: parent.runFile,
        contextId: "ctx1",
        priorState: "needs-review",
        missingEvidence: [],
        prBlockers: [],
        carryEvidence: false,
        evidenceResults: [],
        createdAt: "",
      },
      phases: [{name: "opencode-worker", state: "succeeded"}],
    })
    await writeRun(parent)
    await writeRun(child)
    const state = emptyDmReportState(app)
    const firstSnapshot = await observeRun(app, parent.runId)
    const secondSnapshot = await observeRun(app, child.runId)

    const first = applyObservationReportPolicy(state, observationEvent(firstSnapshot, "state", "running", "needs-review", "warning"), app.config.reporting)
    const second = applyObservationReportPolicy(state, observationEvent(secondSnapshot, "state", "running", "needs-review", "warning"), app.config.reporting)

    expect(first.report).toContain(parent.runId)
    expect(second.report).toBeUndefined()
  })

  test("DM policy reports a new needs-review category within a family", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    const state = emptyDmReportState(app)
    const parent = runRecord(app, {
      runId: "builder-01-root",
      state: "needs-review",
      failureCategory: "verification-evidence-missing",
      process: {},
      context: {id: "ctx1", checkout: "/tmp/checkout", branch: "openteam/test"},
      phases: [{name: "opencode-worker", state: "succeeded"}],
    })
    const child = runRecord(app, {
      runId: "builder-01-child",
      state: "needs-review",
      failureCategory: "dev-server-unhealthy",
      process: {},
      context: {id: "ctx1", checkout: "/tmp/checkout", branch: "openteam/test"},
      continuation: {
        version: 1,
        kind: "repair-evidence",
        fromRunId: parent.runId,
        fromRunFile: parent.runFile,
        contextId: "ctx1",
        priorState: "needs-review",
        failureCategory: "verification-evidence-missing",
        missingEvidence: [],
        prBlockers: [],
        carryEvidence: false,
        evidenceResults: [],
        createdAt: "",
      },
      phases: [{name: "opencode-worker", state: "succeeded"}],
    })
    await writeRun(parent)
    await writeRun(child)
    applyObservationReportPolicy(state, observationEvent(await observeRun(app, parent.runId), "state", "running", "needs-review", "warning"), app.config.reporting)

    const second = applyObservationReportPolicy(state, observationEvent(await observeRun(app, child.runId), "failureCategory", "verification-evidence-missing", "dev-server-unhealthy", "warning"), app.config.reporting)

    expect(second.report).toContain("dev-server-unhealthy")
  })

  test("DM policy reports critical OpenCode blockers while run is non-terminal", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    const record = runRecord(app, {process: {runnerPid: process.pid, opencodePid: process.pid}})
    await writeRun(record)
    const snapshot: RunObservationSnapshot = {
      ...await observeRun(app, record.runId),
      opencodeBlockedKind: "permission",
      opencodeBlockedReason: "OpenCode requested a permission decision",
      opencodeLogAgeMs: 60_000,
      opencodeLastLine: "permission requested: external_directory",
    }
    const state = emptyDmReportState(app)

    const decision = applyObservationReportPolicy(
      state,
      observationEvent(snapshot, "opencodeBlockedKind", undefined, "permission", "critical"),
      app.config.reporting,
    )

    expect(decision.report).toContain("opencode-permission-blocked")
    expect(decision.report).toContain("opencode idle")
  })

  test("digest mode throttles repeated warning observations", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    app.config.reporting.dmObservationMode = "digest"
    const snapshot = {
      ...(await observeRun(app, runRecord(app, {process: {runnerPid: process.pid}}).runId).catch(async () => {
        const record = runRecord(app, {process: {runnerPid: process.pid}})
        await writeRun(record)
        return observeRun(app, record.runId)
      })),
      state: "running",
      devHealthy: false,
      devError: "connection refused",
    }
    const state = emptyDmReportState(app)
    const event = observationEvent(snapshot, "devHealthy", true, false, "warning")

    applyObservationReportPolicy(state, event, app.config.reporting, {now: new Date("2026-04-27T00:00:00.000Z")})
    applyObservationReportPolicy(state, event, app.config.reporting, {now: new Date("2026-04-27T00:01:00.000Z")})

    expect(state.digest.pending).toHaveLength(1)
  })

  test("digest builder emits grouped pending observations and clears emitted items", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    app.config.reporting.dmObservationMode = "digest"
    app.config.reporting.dmDigestIntervalMs = 0
    const state = emptyDmReportState(app)
    const record = runRecord(app, {process: {runnerPid: process.pid}})
    await writeRun(record)
    const snapshot = {...await observeRun(app, record.runId), state: "running", devHealthy: false}
    applyObservationReportPolicy(state, observationEvent(snapshot, "devHealthy", true, false, "warning"), app.config.reporting)

    const digest = buildDueObservationDigest(state, app.config.reporting, {now: new Date("2026-04-27T00:30:00.000Z")})

    expect(digest).toContain("openteam run digest")
    expect(digest).toContain("running: 1")
    expect(state.digest.pending).toHaveLength(0)
  })

  test("failed task run reports point at runs show", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    const record = runRecord(app, {state: "failed", failureCategory: "task-runtime-error", process: {}})

    const report = await formatTaskRunReport(record, {kind: "failed", state: "failed", error: "worker crashed"})

    expect(report).toContain(`next: openteam runs show ${record.runId}`)
    expect(report).toContain("why: worker crashed")
  })
})

describe("Round 7 - continuation and repair flows", () => {
  test("repair-evidence tasks include missing evidence guidance", () => {
    const app = makeApp("/tmp/openteam-runtime")
    const record = runRecord(app, {
      state: "needs-review",
      context: {id: "ctx1", checkout: "/tmp/checkout", branch: "openteam/test"},
      doneContract: createDoneContract("builder", "web", "Fix UI"),
      verification: {plan: createVerificationPlan(app, "web", {stacks: ["web"]}), results: []},
    })

    const item = createContinuationTaskItem(record, {kind: "repair-evidence"})

    expect(item.task).toContain("repair the missing or weak verification evidence")
    expect(item.continuation?.missingEvidence.length).toBeGreaterThan(0)
  })

  test("continuation uses base agent id when prior run had a runtime id", () => {
    const app = makeApp("/tmp/openteam-runtime")
    const item = createContinuationTaskItem(runRecord(app, {
      agentId: "builder-01-job-runtime",
      baseAgentId: "builder-01",
      context: {id: "ctx1", checkout: "/tmp/checkout", branch: "openteam/test"},
    }), {kind: "continue"})

    expect(item.agentId).toBe("builder-01")
  })

  test("carried continuation evidence keeps only successful results", () => {
    const app = makeApp("/tmp/openteam-runtime")
    const item = createContinuationTaskItem(runRecord(app, {
      context: {id: "ctx1", checkout: "/tmp/checkout", branch: "openteam/test"},
      verification: {
        plan: createVerificationPlan(app, "code", {stacks: []}),
        results: [
          {id: "repo-native", kind: "command", state: "succeeded", source: "worker", logFile: "ok.log"},
          {id: "browser", kind: "playwright-mcp", state: "failed", source: "worker", error: "down"},
        ],
      },
    }), {kind: "repair-evidence"})

    expect(continuationEvidenceForCarry(item.continuation).map(result => result.id)).toEqual(["repo-native"])
  })

  test("disabled evidence carry preserves prompt context but carries no results", () => {
    const app = makeApp("/tmp/openteam-runtime")
    const item = createContinuationTaskItem(runRecord(app, {
      context: {id: "ctx1", checkout: "/tmp/checkout", branch: "openteam/test"},
      verification: {
        plan: createVerificationPlan(app, "code", {stacks: []}),
        results: [{id: "repo-native", kind: "command", state: "succeeded", source: "worker", logFile: "ok.log"}],
      },
    }), {kind: "continue", carryEvidence: false})

    expect(item.continuation?.evidenceResults).toHaveLength(1)
    expect(continuationEvidenceForCarry(item.continuation)).toHaveLength(0)
  })

  test("continuation prompt includes prior state, category, blockers, and evidence", () => {
    const app = makeApp("/tmp/openteam-runtime")
    const item = createContinuationTaskItem(runRecord(app, {
      state: "needs-review",
      verificationState: "needs-review",
      failureCategory: "verification-evidence-weak",
      context: {id: "ctx1", checkout: "/tmp/checkout", branch: "openteam/test"},
      doneContract: createDoneContract("builder", "web", "Fix UI"),
      verification: {
        plan: createVerificationPlan(app, "web", {stacks: ["web"]}),
        results: [{id: "browser", kind: "playwright-mcp", state: "failed", source: "worker", error: "down"}],
      },
    }), {kind: "repair-evidence"})

    const prompt = continuationPromptLines(item.continuation).join("\n")

    expect(prompt).toContain("Prior failure category: verification-evidence-weak")
    expect(prompt).toContain("Prior PR blockers")
    expect(prompt).toContain("Prior evidence: browser:failed")
  })

  test("family resolution traces continuation ancestry to the root run", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    const root = runRecord(app, {runId: "builder-root", context: {id: "ctx1", checkout: "/tmp/checkout", branch: "openteam/test"}})
    const child = runRecord(app, {
      runId: "builder-child",
      context: {id: "ctx1", checkout: "/tmp/checkout", branch: "openteam/test"},
      continuation: {
        version: 1,
        kind: "continue",
        fromRunId: root.runId,
        fromRunFile: root.runFile,
        contextId: "ctx1",
        priorState: "needs-review",
        missingEvidence: [],
        prBlockers: [],
        carryEvidence: false,
        evidenceResults: [],
        createdAt: "",
      },
    })
    await writeRun(root)

    expect(await resolveRunFamilyKey(child)).toBe(root.runId)
  })

  test("family resolution falls back when the parent file is unavailable", async () => {
    const app = makeApp("/tmp/openteam-runtime")
    const child = runRecord(app, {
      runId: "builder-child",
      continuation: {
        version: 1,
        kind: "continue",
        fromRunId: "builder-root",
        fromRunFile: "/tmp/missing-run.json",
        contextId: "ctx1",
        priorState: "needs-review",
        missingEvidence: [],
        prBlockers: [],
        carryEvidence: false,
        evidenceResults: [],
        createdAt: "",
      },
    })

    expect(await resolveRunFamilyKey(child)).toBe("builder-root")
  })

  test("continue tasks keep the original task and do not over-focus on evidence repair", () => {
    const app = makeApp("/tmp/openteam-runtime")
    const item = createContinuationTaskItem(runRecord(app, {
      task: "Finish implementation",
      context: {id: "ctx1", checkout: "/tmp/checkout", branch: "openteam/test"},
    }), {kind: "continue"})

    expect(item.task).toContain("Finish implementation")
    expect(item.task).not.toContain("repair the missing or weak verification evidence")
  })

  test("run-family gate blocks default generic continue tasks", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = path.join(runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    const app = makeApp(runtimeRoot)
    const repo = identity()
    await writeRegistry(app, registryWith(repo, {
      ctx1: leasedContext(checkout, {state: "idle", lease: undefined, repoKey: repo.key}),
    }))
    const record = runRecord(app, {
      state: "needs-review",
      failureCategory: "verification-evidence-missing",
      context: {id: "ctx1", checkout, branch: "openteam/test"},
      doneContract: createDoneContract("builder", "code", "Fix helper crash"),
      verification: {plan: createVerificationPlan(app, "code", {stacks: []}), results: []},
    })
    const item = createContinuationTaskItem(record, {kind: "continue"})

    const gate = await evaluateContinuationGate(app, record, item, {explicitTask: false})

    expect(gate.allowed).toBe(false)
    expect(gate.blockers.join(" ")).toContain("must state what is different")
  })

  test("run-family gate allows default repair-evidence when evidence is missing", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = path.join(runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    const app = makeApp(runtimeRoot)
    const repo = identity()
    await writeRegistry(app, registryWith(repo, {
      ctx1: leasedContext(checkout, {state: "idle", lease: undefined, repoKey: repo.key}),
    }))
    const record = runRecord(app, {
      state: "needs-review",
      failureCategory: "verification-evidence-missing",
      context: {id: "ctx1", checkout, branch: "openteam/test"},
      doneContract: createDoneContract("builder", "code", "Fix helper crash"),
      verification: {plan: createVerificationPlan(app, "code", {stacks: []}), results: []},
    })
    const item = createContinuationTaskItem(record, {kind: "repair-evidence"})

    const gate = await evaluateContinuationGate(app, record, item, {explicitTask: false})

    expect(gate.allowed).toBe(true)
    expect(gate.family.attemptCount).toBe(1)
    expect(gate.family.lastFailureCategory).toBe("verification-evidence-missing")
  })

  test("run-family gate blocks a third same-category attempt", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = path.join(runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    const app = makeApp(runtimeRoot)
    const repo = identity()
    await writeRegistry(app, registryWith(repo, {
      ctx1: leasedContext(checkout, {state: "idle", lease: undefined, repoKey: repo.key}),
    }))
    const root = runRecord(app, {
      runId: "builder-root",
      state: "needs-review",
      failureCategory: "verification-evidence-missing",
      context: {id: "ctx1", checkout, branch: "openteam/test"},
      doneContract: createDoneContract("builder", "code", "Fix helper crash"),
      verification: {plan: createVerificationPlan(app, "code", {stacks: []}), results: []},
    })
    await writeRun(root)
    const second = runRecord(app, {
      runId: "builder-second",
      state: "needs-review",
      failureCategory: "verification-evidence-missing",
      context: {id: "ctx1", checkout, branch: "openteam/test"},
      doneContract: createDoneContract("builder", "code", "Fix helper crash"),
      verification: {plan: createVerificationPlan(app, "code", {stacks: []}), results: []},
      continuation: {
        version: 1,
        kind: "repair-evidence",
        fromRunId: root.runId,
        fromRunFile: root.runFile,
        contextId: "ctx1",
        priorState: "needs-review",
        failureCategory: root.failureCategory,
        missingEvidence: [],
        prBlockers: [],
        carryEvidence: false,
        evidenceResults: [],
        createdAt: "",
      },
    })
    const item = createContinuationTaskItem(second, {kind: "repair-evidence"})

    const gate = await evaluateContinuationGate(app, second, item, {explicitTask: false})

    expect(gate.allowed).toBe(false)
    expect(gate.family.failureCounts["verification-evidence-missing"]).toBe(2)
    expect(gate.blockers.join(" ")).toContain("already has 2 attempts")
  })

  test("run-family gate force allows repeated categories and persists launch metadata", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = path.join(runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    const app = makeApp(runtimeRoot)
    const repo = identity()
    await writeRegistry(app, registryWith(repo, {
      ctx1: leasedContext(checkout, {state: "idle", lease: undefined, repoKey: repo.key}),
    }))
    const root = runRecord(app, {
      runId: "builder-root",
      state: "needs-review",
      failureCategory: "verification-evidence-missing",
      context: {id: "ctx1", checkout, branch: "openteam/test"},
      doneContract: createDoneContract("builder", "code", "Fix helper crash"),
      verification: {plan: createVerificationPlan(app, "code", {stacks: []}), results: []},
    })
    await writeRun(root)
    const second = runRecord(app, {
      runId: "builder-second",
      state: "needs-review",
      failureCategory: "verification-evidence-missing",
      context: {id: "ctx1", checkout, branch: "openteam/test"},
      doneContract: createDoneContract("builder", "code", "Fix helper crash"),
      verification: {plan: createVerificationPlan(app, "code", {stacks: []}), results: []},
      continuation: {
        version: 1,
        kind: "repair-evidence",
        fromRunId: root.runId,
        fromRunFile: root.runFile,
        contextId: "ctx1",
        priorState: "needs-review",
        failureCategory: root.failureCategory,
        missingEvidence: [],
        prBlockers: [],
        carryEvidence: false,
        evidenceResults: [],
        createdAt: "",
      },
    })
    const item = createContinuationTaskItem(second, {kind: "repair-evidence"})

    const gate = await evaluateContinuationGate(app, second, item, {explicitTask: false, force: true})
    recordContinuationLaunch(gate, "openteam runs repair-evidence builder-second --force")
    await writeRunFamilyState(gate.state)
    const saved = await readRunFamilyState(app)
    const family = saved.families[gate.familyKey]

    expect(gate.allowed).toBe(true)
    expect(gate.forced).toBe(true)
    expect(family?.forcedCount).toBe(1)
    expect(family?.lastLaunchedCommand).toContain("--force")
  })

  test("run-family gate allows explicit materially different continue tasks", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = path.join(runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    const app = makeApp(runtimeRoot)
    const repo = identity()
    await writeRegistry(app, registryWith(repo, {
      ctx1: leasedContext(checkout, {state: "idle", lease: undefined, repoKey: repo.key}),
    }))
    const record = runRecord(app, {
      state: "needs-review",
      failureCategory: "dev-server-unhealthy",
      context: {id: "ctx1", checkout, branch: "openteam/test"},
      doneContract: createDoneContract("builder", "web", "Fix checkout UI"),
      verification: {plan: createVerificationPlan(app, "web", {stacks: ["web"]}), results: []},
    })
    const item = createContinuationTaskItem(record, {
      kind: "continue",
      task: "Narrow the next attempt to repair the dev-server blocker, then run browser verification and record evidence.",
    })

    const gate = await evaluateContinuationGate(app, record, item, {explicitTask: true})

    expect(gate.allowed).toBe(true)
    expect(gate.blockers).toEqual([])
  })

  test("run-family gate blocks continuations when the context is leased by another run", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = path.join(runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    const app = makeApp(runtimeRoot)
    const repo = identity()
    await writeRegistry(app, registryWith(repo, {
      ctx1: leasedContext(checkout, {
        repoKey: repo.key,
        lease: {
          workerId: "builder-02",
          role: "builder",
          jobId: "other-task",
          mode: "code",
          leasedAt: "2026-04-25T00:00:00.000Z",
        },
      }),
    }))
    const record = runRecord(app, {
      state: "needs-review",
      failureCategory: "verification-evidence-missing",
      context: {id: "ctx1", checkout, branch: "openteam/test"},
      doneContract: createDoneContract("builder", "code", "Fix helper crash"),
      verification: {plan: createVerificationPlan(app, "code", {stacks: []}), results: []},
    })
    const item = createContinuationTaskItem(record, {kind: "repair-evidence"})

    const gate = await evaluateContinuationGate(app, record, item, {explicitTask: false})

    expect(gate.allowed).toBe(false)
    expect(gate.blockers.join(" ")).toContain("builder-02/other-task")
  })

  test("run-family gate blocks stale no-evidence continuations by default", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = path.join(runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    const app = makeApp(runtimeRoot)
    const context = leasedContext(checkout)
    context.state = "idle"
    context.lease = undefined
    await writeRegistry(app, registryWith(identity(), {ctx1: context}))
    const record = runRecord(app, {
      state: "stale",
      context: {id: "ctx1", checkout, branch: "openteam/test"},
      doneContract: createDoneContract("builder", "code", "Fix helper crash"),
      verification: {plan: createVerificationPlan(app, "code", {stacks: []}), results: []},
    })
    const item = createContinuationTaskItem(record, {
      kind: "continue",
      task: "Run a narrow repo-native verification pass and record evidence for the prior edit",
    })

    const gate = await evaluateContinuationGate(app, record, item, {explicitTask: true})

    expect(gate.allowed).toBe(false)
    expect(gate.blockers.join("\n")).toContain("stale and has no carried evidence")
  })

  test("run-family gate allows retry for no-progress OpenCode database locks", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = path.join(runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    const app = makeApp(runtimeRoot)
    const context = leasedContext(checkout)
    context.state = "idle"
    context.lease = undefined
    await writeRegistry(app, registryWith(identity(), {ctx1: context}))
    const logFile = path.join(runtimeRoot, "worker.log")
    await writeFile(logFile, "Error: database is locked\n")
    const record = runRecord(app, {
      state: "failed",
      failureCategory: "opencode-database-locked",
      context: {id: "ctx1", checkout, branch: "openteam/test"},
      logs: {opencode: logFile},
      doneContract: createDoneContract("builder", "code", "Fix helper crash"),
      verification: {plan: createVerificationPlan(app, "code", {stacks: []}), results: []},
    })
    const item = createContinuationTaskItem(record, {kind: "retry"})

    const gate = await evaluateContinuationGate(app, record, item, {explicitTask: false})

    expect(gate.allowed).toBe(true)
    expect(gate.blockers).toHaveLength(0)
  })

  test("run-family gate blocks retry when the prior run has implementation progress", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const checkout = await initRepo()
    await writeFile(path.join(checkout, "src.txt"), "changed\n")
    const baseCommit = runGit(checkout, ["rev-parse", "HEAD"])
    const context = leasedContext(checkout, {baseCommit})
    context.state = "idle"
    context.lease = undefined
    await writeRegistry(app, registryWith(identity(), {ctx1: context}))
    const logFile = path.join(runtimeRoot, "worker.log")
    await writeFile(logFile, "Error: database is locked\n")
    const record = runRecord(app, {
      state: "failed",
      failureCategory: "opencode-database-locked",
      context: {id: "ctx1", checkout, branch: "openteam/test", baseCommit},
      logs: {opencode: logFile},
      doneContract: createDoneContract("builder", "code", "Fix helper crash"),
      verification: {plan: createVerificationPlan(app, "code", {stacks: []}), results: []},
    })
    const item = createContinuationTaskItem(record, {kind: "retry"})

    const gate = await evaluateContinuationGate(app, record, item, {explicitTask: false})

    expect(gate.allowed).toBe(false)
    expect(gate.blockers.join("\n")).toContain("implementation progress")
  })

  test("run-family launch accounting records queued continuation attempts immediately", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = path.join(runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    const app = makeApp(runtimeRoot)
    const context = leasedContext(checkout)
    context.state = "idle"
    context.lease = undefined
    await writeRegistry(app, registryWith(identity(), {ctx1: context}))
    const record = runRecord(app, {
      state: "needs-review",
      failureCategory: "verification-evidence-missing",
      context: {id: "ctx1", checkout, branch: "openteam/test"},
      doneContract: createDoneContract("builder", "code", "Fix helper crash"),
      verification: {plan: createVerificationPlan(app, "code", {stacks: []}), results: []},
    })
    const item = createContinuationTaskItem(record, {
      kind: "repair-evidence",
      task: "Run repo-native verification and record the missing command evidence",
    })
    const gate = await evaluateContinuationGate(app, record, item, {explicitTask: true})

    recordContinuationLaunch(gate, "openteam runs repair-evidence builder-01-task-a", {
      runId: `builder-01-${item.id}`,
      state: "queued",
      failureCategory: item.continuation?.failureCategory,
    })

    expect(gate.family.runs[`builder-01-${item.id}`]?.state).toBe("queued")
    expect(gate.family.attemptCount).toBe(2)
  })

  test("continuation handoff summaries redact secrets from prior logs", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = path.join(runtimeRoot, "checkout")
    await mkdir(path.join(checkout, ".openteam"), {recursive: true})
    const app = makeApp(runtimeRoot)
    const logFile = path.join(runtimeRoot, "prior.log")
    await writeFile(logFile, [
      "OPENTEAM_GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456",
      "OPENTEAM_BUILDER_01_SEC=nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
      "normal finding",
    ].join("\n"))
    const record = runRecord(app, {
      state: "failed",
      failureCategory: "tool-permission-rejected",
      context: {id: "ctx1", checkout, branch: "openteam/test"},
      logs: {opencode: logFile},
    })
    const item = createContinuationTaskItem(record, {
      kind: "continue",
      task: "Use the sanitized handoff and do not inspect runtime logs",
    })

    const file = await writeContinuationHandoff(app, record, item)
    const text = await readFile(file!, "utf8")

    expect(text).toContain("[REDACTED]")
    expect(text).toContain("normal finding")
    expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456")
    expect(text).not.toContain("nsec1qqqq")
  })
})

describe("Round 8 - orchestrator command routing", () => {
  test("parses question mark as help", () => {
    expect(parseOperatorRequest("?")).toEqual({kind: "help"})
  })

  test("parses status aliases", () => {
    expect(parseOperatorRequest("what is running?")).toEqual({kind: "status"})
    expect(parseOperatorRequest("worker list")).toEqual({kind: "status"})
  })

  test("parses quoted stop targets", () => {
    expect(parseOperatorRequest("stop 'builder-job-1'")).toEqual({kind: "stop", name: "builder-job-1"})
  })

  test("parses start commands with mode and model", () => {
    expect(parseOperatorRequest("start builder on repo in web mode with model openai/gpt-5.4")).toEqual({
      kind: "start",
      role: "builder",
      target: "repo",
      mode: "web",
      model: "openai/gpt-5.4",
    })
  })

  test("watch defaults to triager role", () => {
    expect(parseOperatorRequest("watch repo in code mode")).toEqual({
      kind: "watch",
      role: "triager",
      target: "repo",
      mode: "code",
      model: undefined,
    })
  })

  test("work defaults to builder role and carries parallel flag", () => {
    expect(parseOperatorRequest("work on repo in parallel and do fix the crash")).toEqual({
      kind: "work",
      role: "builder",
      target: "repo",
      mode: undefined,
      model: undefined,
      parallel: true,
      task: "fix the crash",
    })
  })

  test("plan shortcut creates a researcher code task by default", () => {
    expect(parseOperatorRequest("plan repo and reduce failed runs")).toEqual({
      kind: "research",
      role: "researcher",
      target: "repo",
      mode: "code",
      model: undefined,
      parallel: false,
      task: "Produce a research-backed implementation plan: reduce failed runs",
    })
  })

  test("unmatched requests fall back to conversational orchestrator handling", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    const result = await dispatchOperatorRequest(app, "can you think about this?")

    expect(result.handled).toBe(false)
    expect(result.summary).toContain("not matched")
  })
})

describe("Round 9 - verification planning and project profile coverage", () => {
  test("undefined configured runners are surfaced as unavailable", () => {
    const app = makeApp("/tmp/openteam-runtime")
    app.config.verification = {defaultRunners: {code: ["missing-runner"]}, runners: {}}

    const plan = createVerificationPlan(app, "code", {stacks: []})

    expect(plan.runners[0]?.configured).toBe(false)
    expect(plan.runners[0]?.reason).toContain("not defined")
  })

  test("browser runner is unavailable without an MCP command", () => {
    const app = makeApp("/tmp/openteam-runtime")
    app.config.browser.mcp.command = []

    const plan = createVerificationPlan(app, "web", {stacks: ["web"]})

    expect(verificationPlanSummary(plan)).toContain("browser:unavailable")
  })

  test("verification results append in order and reset to empty", async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-checkout-"))
    await appendVerificationResultsFile(checkout, [{id: "one", kind: "command", state: "succeeded"}])
    await appendVerificationResultsFile(checkout, [{id: "two", kind: "command", state: "failed"}])

    expect((await readVerificationResults(checkout)).map(result => result.id)).toEqual(["one", "two"])
    await resetVerificationResults(checkout)
    expect(await readVerificationResults(checkout)).toEqual([])
  })

  test("manual browser evidence records flow and screenshots", () => {
    const app = makeApp("/tmp/openteam-runtime")
    const runner = createVerificationPlan(app, "web", {stacks: ["web"]}).runners.find(item => item.id === "browser")!

    const result = manualVerificationResult(runner, {
      state: "succeeded",
      flow: "checkout flow",
      screenshots: [".openteam/artifacts/browser/checkout.png"],
    })

    expect(result.evidenceType).toBe("browser")
    expect(result.flow).toBe("checkout flow")
    expect(result.screenshots).toHaveLength(1)
  })

  test("agentic browser runner asks workers to record browser evidence instead of silently passing", async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-checkout-"))
    const app = makeApp("/tmp/openteam-runtime")
    const plan = createVerificationPlan(app, "web", {stacks: ["web"]})

    const [result] = await runVerificationRunner({checkout, plan, runnerId: "browser", source: "worker"})

    expect(result?.state).toBe("skipped")
    expect(result?.skippedReason).toContain("verify record browser")
  })

  test("local command runners write successful structured results", async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-checkout-"))
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    app.config.verification = {
      defaultRunners: {code: ["repo-native"]},
      runners: {"repo-native": {kind: "command", enabled: true, local: true, modes: ["code"], command: ["sh", "-c", "true"]}},
    }

    const [result] = await runLocalVerificationRunners({checkout, plan: createVerificationPlan(app, "code", {stacks: []})})

    expect(result?.state).toBe("succeeded")
    expect(result?.logFile).toBeTruthy()
  })

  test("declared nix flakes wrap verification commands", async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-checkout-"))
    await writeFile(path.join(checkout, ".envrc"), "use flake\n")
    await writeFile(path.join(checkout, "flake.nix"), "{}\n")

    const devEnv = await detectDevEnv(checkout)

    expect(devEnv.kind).toBe("nix-flake")
    expect(wrapDevEnvCommand(devEnv, "bun", ["test"])).toEqual({cmd: "nix", args: ["develop", "--command", "bun", "test"]})
  })

  test("project profiles surface workspace dependency provisioning blockers", async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-checkout-"))
    await writeFile(path.join(checkout, "package.json"), JSON.stringify({
      dependencies: {"@org/lib": "workspace:*"},
      scripts: {test: "vitest run"},
      packageManager: "pnpm@10.0.0",
    }))

    const profile = await detectProjectProfile(checkout, {kind: "none", commandPrefix: []})

    expect(profile.blockers.join(" ")).toContain("workspace: dependencies")
    expect(profile.likelyCommands.some(item => item.command.join(" ") === "pnpm run test")).toBe(true)
  })

  test("provisioning failure categories separate worker control, profile blockers, and wrapper failures", () => {
    expect(categorizeProvisioningFailure({
      logText: "I will run openteam launch builder --task retry",
      projectProfile: {blockers: []},
    })).toBe("provision-worker-control")
    expect(categorizeProvisioningFailure({
      logText: "install failed",
      projectProfile: {blockers: ["workspace: dependencies require workspace sibling packages"]},
    })).toBe("project-profile-blocker")
    expect(categorizeProvisioningFailure({
      logText: "nix develop failed to enter the dev shell",
      projectProfile: {blockers: []},
    })).toBe("dev-env-wrapper-failed")
  })

  test("run summaries expose durable provisioning state fields", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    await writeRun(runRecord(app, {
      state: "failed",
      process: {},
      failureCategory: "provision-worker-control",
      provisionState: "failed",
      provisionFailureCategory: "provision-worker-control",
      projectProfilePath: "/work/repo/.openteam/project-profile.json",
      verificationToolingReady: false,
    }))

    const [summary] = await summarizeRuns(app, await recentRunRecords(app, 10))

    expect(summary?.provisionState).toBe("failed")
    expect(summary?.provisionFailureCategory).toBe("provision-worker-control")
    expect(summary?.projectProfilePath).toContain("project-profile.json")
    expect(summary?.verificationToolingReady).toBe(false)
  })
})

describe("Round 10 - status and observability surfaces", () => {
  test("runtime status counts live orchestrator workers", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    await mkdir(path.join(runtimeRoot, "orchestrator"), {recursive: true})
    await writeFile(path.join(runtimeRoot, "orchestrator", "workers.json"), JSON.stringify([{
      name: "orchestrator-01",
      kind: "worker",
      agentId: "orchestrator-01",
      role: "orchestrator",
      pid: process.pid,
      logFile: "/tmp/orchestrator.log",
      startedAt: "2026-04-27T00:00:00.000Z",
    }], null, 2))

    const status = await refreshRuntimeStatus(app)

    expect(status.orchestratorPid).toBe(process.pid)
    expect(status.workers.live).toBe(1)
  })

  test("runtime status prunes dead worker entries", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const app = makeApp(runtimeRoot)
    const workersFile = path.join(runtimeRoot, "orchestrator", "workers.json")
    await mkdir(path.dirname(workersFile), {recursive: true})
    await writeFile(workersFile, JSON.stringify([{
      name: "dead-builder",
      kind: "worker",
      agentId: "builder-01",
      role: "builder",
      pid: 999999999,
      logFile: "/tmp/dead.log",
      startedAt: "2026-04-27T00:00:00.000Z",
    }], null, 2))

    const status = await refreshRuntimeStatus(app)
    const saved = JSON.parse(await readFile(workersFile, "utf8")) as unknown[]

    expect(status.workers.live).toBe(0)
    expect(saved).toEqual([])
  })

  test("runtime status counts effective failed runs", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    await writeRun(runRecord(app, {
      state: "succeeded",
      workerState: "succeeded",
      verificationState: "failed",
      failureCategory: "dev-server-unhealthy",
      process: {},
      doneContract: createDoneContract("builder", "web", "Fix UI"),
      phases: [{name: "verify-dev-server", state: "failed"}],
    }))

    const status = await refreshRuntimeStatus(app)

    expect(status.runs.byState.failed).toBe(1)
  })

  test("runtime status marks leased contexts stale without a matching running run", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = path.join(runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    const app = makeApp(runtimeRoot)
    await writeRegistry(app, registryWith(identity(), {ctx1: leasedContext(checkout)}))

    const status = await refreshRuntimeStatus(app)

    expect(status.leases.stale).toBe(1)
    expect(status.leases.staleContexts[0]?.reason).toContain("no live running run matches lease")
  })

  test("runtime status keeps matching live running leases out of stale contexts", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const checkout = path.join(runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    const app = makeApp(runtimeRoot)
    await writeRegistry(app, registryWith(identity(), {ctx1: leasedContext(checkout)}))
    await writeRun(runRecord(app, {
      process: {runnerPid: process.pid},
      context: {id: "ctx1", checkout, branch: "openteam/test"},
    }))

    const status = await refreshRuntimeStatus(app)

    expect(status.leases.leased).toBe(1)
    expect(status.leases.stale).toBe(0)
  })

  test("status report summarizes stale runs and writes status file", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    await writeRun(runRecord(app, {process: {}}))

    const report = await statusReport(app)

    expect(report.summary.staleRuns).toBe(1)
    expect(existsSync(report.summary.statusFile)).toBe(true)
  })

  test("recent run records ignore invalid JSON files", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    await writeRun(runRecord(app, {runId: "valid"}))
    await writeFile(path.join(app.config.runtimeRoot, "runs", "invalid.json"), "{not json")

    const records = await recentRunRecords(app, 10)

    expect(records.map(item => item.record.runId)).toEqual(["valid"])
  })

  test("runtime status preserves previous cleanup metadata across refreshes", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    await refreshRuntimeStatus(app, {lastCleanupAt: "2026-04-27T00:00:00.000Z", lastCleanupCount: 2})

    const next = await refreshRuntimeStatus(app)

    expect(next.cleanup.lastCleanupAt).toBe("2026-04-27T00:00:00.000Z")
    expect(next.cleanup.lastCleanupCount).toBe(2)
  })
})
