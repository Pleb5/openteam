import {describe, expect, test} from "bun:test"
import {mkdtemp, readFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {createDoneContract} from "../src/done-contract.js"
import {
  buildTaskManifest,
  readTaskManifest,
  taskManifestPath,
  writeTaskManifest,
  type BuildTaskManifestInput,
} from "../src/task-manifest.js"
import type {ProjectSignal} from "../src/project-profile.js"
import type {AppCfg, PreparedAgent, RepoIdentity, ResolvedRepoTarget, TaskItem, VerificationPlan} from "../src/types.js"

const app = (checkout: string): AppCfg => ({
  root: "/repo",
  config: {
    runtimeRoot: "/repo/runtime",
    opencode: {binary: "opencode", model: "provider/model", agent: "build"},
    browser: {
      headless: true,
      mcp: {name: "playwright", command: [], environment: {}},
    },
    providers: {
      "github.com": {
        type: "github",
        host: "github.com",
        token: "provider-token-secret",
      },
    },
    repos: {
      app: {
        root: checkout,
        baseBranch: "main",
        sharedPaths: [],
        mode: "code",
      },
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
    agents: {},
  },
})

const identity = (key: string): RepoIdentity => ({
  key,
  ownerPubkey: "f".repeat(64),
  ownerNpub: "npub1owner",
  identifier: key.split(":").at(-1) ?? "app",
  announcementEventId: "announcement-a",
  announcedAt: 1,
  relays: ["wss://relay.example.com"],
  cloneUrls: ["https://clone-user:clone-secret@example.com/app.git"],
  defaultBranch: "main",
  rawTags: [["d", "app"]],
})

const input = (checkout: string): BuildTaskManifestInput => {
  const testApp = app(checkout)
  const repo = testApp.config.repos.app
  const agent: PreparedAgent = {
    app: testApp,
    id: "builder-01",
    configId: "builder-01",
    meta: {
      id: "builder-01",
      role: "builder",
      soul: "builder",
      repo: "app",
      description: "",
      capabilities: [],
    },
    agent: {
      role: "builder",
      soul: "builder",
      repo: "app",
      portStart: 18471,
      reporting: {},
      identity: {
        npub: "",
        sec: "agent-secret",
        bunkerProfile: "builder-01",
        nakClientKey: "nak-secret",
      },
      nostr_git: {},
    },
    repo,
    paths: {
      root: "/repo/runtime/agents/builder-01",
      workspace: "/repo/runtime/agents/builder-01/workspace",
      memory: "/repo/runtime/agents/builder-01/workspace/MEMORY.md",
      tasks: "/repo/runtime/agents/builder-01/tasks",
      queue: "/repo/runtime/agents/builder-01/queue",
      history: "/repo/runtime/agents/builder-01/history",
      artifacts: "/repo/runtime/agents/builder-01/artifacts",
      browser: "/repo/runtime/agents/builder-01/browser",
      stateFile: "/repo/runtime/agents/builder-01/state.json",
    },
  }
  const resolved: ResolvedRepoTarget = {
    repo,
    identity: identity("30617:owner:app"),
    upstreamIdentity: identity("30617:upstream:app"),
    fork: {
      upstreamKey: "30617:upstream:app",
      forkKey: "30617:owner:app-fork",
      ownerPubkey: "e".repeat(64),
      ownerNpub: "npub1forkowner",
      forkIdentifier: "app-fork",
      forkAnnouncementEventId: "fork-announcement",
      upstreamCloneUrl: "https://example.com/app.git",
      forkCloneUrl: "https://fork-user:fork-secret@example.com/app-fork.git",
      forkCloneUrls: ["https://fork-user:fork-secret@example.com/app-fork.git"],
      authUsername: "secret-username",
      provider: "github",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    },
    context: {
      id: "ctx-a",
      repoKey: "30617:owner:app",
      upstreamRepoKey: "30617:upstream:app",
      path: checkout,
      checkout,
      mirror: path.join(checkout, ".git"),
      mode: "code",
      baseRef: "main",
      baseCommit: "abc123",
      branch: "openteam/task",
      state: "leased",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    },
    target: "https://target-user:target-secret@example.com/app.git",
  }
  const task: TaskItem = {
    id: "task-a",
    task: "fix the thing",
    createdAt: "2026-05-01T00:00:00.000Z",
    state: "running",
    agentId: "builder-01",
    mode: "code",
    model: "provider/model",
    source: {kind: "dm", eventId: "event-a", from: "npub1operator"},
    continuation: {
      version: 1,
      kind: "repair-evidence",
      fromRunId: "run-parent",
      originRunId: "run-root",
      originTask: "fix the original thing",
      priorTask: "repair failed evidence",
      ancestry: [{runId: "run-root", task: "fix the original thing", state: "failed"}],
      fromRunFile: "/repo/runtime/runs/run-parent.json",
      contextId: "ctx-a",
      priorState: "needs-review",
      evidenceLevel: "missing",
      missingEvidence: ["repo-native validation"],
      prBlockers: ["missing evidence"],
      carryEvidence: true,
      evidenceResults: [{
        id: "manual",
        kind: "command",
        state: "succeeded",
        note: "prior-secret-evidence",
      }],
      createdAt: "2026-05-01T00:00:00.000Z",
    },
  }
  const verificationPlan: VerificationPlan = {
    version: 1,
    mode: "code",
    profileStacks: ["node"],
    selectedRunnerIds: ["repo-native"],
    runners: [{
      id: "repo-native",
      kind: "command",
      enabled: true,
      configured: true,
      local: true,
      modes: ["code"],
      stacks: [],
    }],
  }

  return {
    agent,
    item: task,
    runRecord: {
      runId: "builder-01-task-a",
      runFile: "/repo/runtime/runs/builder-01-task-a.json",
      taskId: "task-a",
      startedAt: "2026-05-01T00:00:00.000Z",
      opencodeAgent: "openteam-builder",
    },
    resolved,
    repoPolicy: {
      repoRelays: ["wss://relay.example.com"],
      publishRelays: ["wss://relay.example.com"],
      naddrRelays: [],
      taggedRelays: ["wss://relay.example.com"],
      isGrasp: false,
    },
    defaultPublishScope: "upstream",
    devEnv: {kind: "none", commandPrefix: []},
    projectProfile: {
      version: 1,
      generatedAt: "2026-05-01T00:00:00.000Z",
      checkout,
      declaredEnvironment: {kind: "none"},
      docs: ["README.md"],
      stacks: ["node"],
      signals: [] as ProjectSignal[],
      likelyCommands: [],
      blockers: [],
      guidance: [],
    },
    projectProfileFile: path.join(checkout, ".openteam", "project-profile.json"),
    verificationPlan,
    verificationPlanFile: path.join(checkout, ".openteam", "verification-plan.json"),
    doneContract: createDoneContract("builder", "code", "fix the thing"),
  }
}

describe("task manifest", () => {
  test("uses the checkout-local manifest path", () => {
    expect(taskManifestPath("/work/repo")).toBe("/work/repo/.openteam/task.json")
  })

  test("builds the structured worker handoff without leaking secrets", () => {
    const manifest = buildTaskManifest(input("/work/repo"))
    const text = JSON.stringify(manifest)

    expect(manifest.version).toBe(1)
    expect(manifest.run.role).toBe("builder")
    expect(manifest.run.mode).toBe("code")
    expect(manifest.task.text).toBe("fix the thing")
    expect(manifest.task.target).toBe("https://example.com/app.git")
    expect(manifest.repo.contextId).toBe("ctx-a")
    expect(manifest.publication.defaultScope).toBe("upstream")
    expect(manifest.publication.normalPrRequiresStrongEvidence).toBe(true)
    expect(manifest.verification.plan.selectedRunnerIds).toEqual(["repo-native"])
    expect(manifest.environment.runtimePath).toContain("orchestrator-only")
    expect(manifest.environment.cachePath).toBe("OPENTEAM_CACHE_DIR")
    expect(manifest.environment.scratchPath).toBe("OPENTEAM_TMP_DIR")
    expect(manifest.environment.artifactsPath).toBe("OPENTEAM_ARTIFACTS_DIR")
    expect(manifest.environment.workspace.artifacts).toEqual({env: "OPENTEAM_ARTIFACTS_DIR", access: "read-write"})
    expect(text).not.toContain("/work/.openteam-runtime")
    expect(text).not.toContain("/repo/runtime/runs")
    expect(manifest.task.continuation?.missingEvidence).toEqual(["repo-native validation"])
    expect(manifest.task.continuation?.originRunId).toBe("run-root")
    expect(manifest.task.continuation?.originTask).toBe("fix the original thing")
    expect(manifest.task.continuation?.priorTask).toBe("repair failed evidence")
    expect(manifest.task.continuation?.ancestry?.[0]?.runId).toBe("run-root")
    expect(text).not.toContain("provider-token-secret")
    expect(text).not.toContain("agent-secret")
    expect(text).not.toContain("nak-secret")
    expect(text).not.toContain("secret-username")
    expect(text).not.toContain("clone-secret")
    expect(text).not.toContain("fork-secret")
    expect(text).not.toContain("target-secret")
    expect(text).not.toContain("prior-secret-evidence")
  })

  test("records resolved model profile selection separately from the raw task override", () => {
    const base = input("/work/repo")
    const manifest = buildTaskManifest({
      ...base,
      item: {
        ...base.item,
        model: undefined,
        modelProfile: "builder-strong",
      },
      modelSelection: {
        model: "provider/resolved",
        variant: "high",
        modelProfile: "builder-strong",
        workerProfile: "builder",
        source: "task-model-profile",
      },
    })

    expect(manifest.run.model).toBe("provider/resolved")
    expect(manifest.run.requestedModel).toBeUndefined()
    expect(manifest.run.requestedModelProfile).toBe("builder-strong")
    expect(manifest.run.modelProfile).toBe("builder-strong")
    expect(manifest.run.modelVariant).toBe("high")
    expect(manifest.run.workerProfile).toBe("builder")
    expect(manifest.run.modelSource).toBe("task-model-profile")
    expect(manifest.run.opencodeAgent).toBe("openteam-builder")
  })

  test("records sanitized opencode runtime handoff", () => {
    const base = input("/work/repo")
    const manifest = buildTaskManifest({
      ...base,
      opencodeRuntime: {
        version: 1,
        generatedAt: "2026-05-01T00:00:00.000Z",
        agent: "openteam-builder",
        binary: "opencode",
        model: "openai/gpt-5.5",
        variant: "xhigh",
        modelProfile: "builder-default",
        modelSource: "worker-profile",
        provider: "openai",
        modelId: "gpt-5.5",
        selectedModelAvailable: true,
        availableModels: [{model: "openai/gpt-5.5", variant: "xhigh", source: "modelProfile", profile: "builder-default"}],
        auth: {
          sourceDataDir: "(host OpenCode data dir; path withheld)",
          sourceStateDir: "(host OpenCode state dir; path withheld)",
          authJsonPresent: true,
          modelJsonPresent: true,
          kvJsonPresent: true,
          hydrated: true,
          status: "ready",
        },
        files: {
          json: "/work/repo/.openteam/opencode-runtime.json",
          summary: "/work/repo/.openteam/context/opencode-auth.md",
        },
      },
    })

    expect(manifest.opencode?.provider).toBe("openai")
    expect(manifest.opencode?.auth.status).toBe("ready")
    expect(JSON.stringify(manifest)).not.toContain("auth.json")
  })

  test("records web runtime facts without storing the signer URL", () => {
    const manifest = buildTaskManifest({
      ...input("/work/repo"),
      runtime: {
        opencodeLogFile: "/repo/runtime/agents/builder-01/artifacts/task.log",
        web: {
          url: "http://127.0.0.1:18471",
          browserProfile: "/repo/runtime/agents/builder-01/browser/profile",
          browserArtifacts: "/repo/runtime/agents/builder-01/artifacts/playwright",
          headless: true,
          remoteSignerAvailable: true,
        },
      },
    })
    const text = JSON.stringify(manifest)

    expect(manifest.runtime?.web?.url).toBe("http://127.0.0.1:18471")
    expect(manifest.runtime?.web?.remoteSignerAvailable).toBe(true)
    expect(manifest.runtime?.opencodeLogFile).toContain("orchestrator-only")
    expect(manifest.runtime?.web?.browserProfile).toContain("orchestrator-only")
    expect(manifest.runtime?.web?.browserArtifacts).toBe("OPENTEAM_ARTIFACTS_DIR")
    expect(text).not.toContain("/repo/runtime")
    expect(text).not.toContain("bunker://")
  })

  test("writes and reads .openteam/task.json", async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-task-manifest-"))
    const file = await writeTaskManifest(input(checkout))
    const raw = await readFile(file, "utf8")
    const manifest = await readTaskManifest(checkout)

    expect(file).toBe(path.join(checkout, ".openteam", "task.json"))
    expect(raw).toContain("\"version\": 1")
    expect(manifest.files.taskManifest).toBe(file)
    expect(manifest.files.verificationResults).toBe(path.join(checkout, ".openteam", "verification-results.json"))
  })
})
