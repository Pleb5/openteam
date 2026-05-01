import {describe, expect, test} from "bun:test"
import {resolveModelSelection, resolveWorkerProfile, workerProfilePromptLines} from "../src/model-profiles.js"
import type {AppCfg, PreparedAgent} from "../src/types.js"

const app = (patch: Partial<AppCfg["config"]> = {}): AppCfg => ({
  root: "/repo",
  config: {
    runtimeRoot: "/repo/runtime",
    opencode: {binary: "opencode", model: "fallback/model", agent: "build"},
    browser: {
      headless: true,
      mcp: {name: "playwright", command: [], environment: {}},
    },
    providers: {},
    repos: {
      app: {
        root: "/repo",
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
    modelProfiles: {
      task: {model: "provider/task", variant: "high"},
      agent: {model: "provider/agent", variant: "medium"},
      worker: {model: "provider/worker", variant: "low"},
      role: {model: "provider/role"},
      global: {model: "provider/global", variant: "minimal"},
    },
    workerProfiles: {
      builder: {
        modelProfile: "role",
        canEdit: true,
        canPublishPr: true,
        canUseBrowser: true,
        canSpawnSubagents: true,
        requiresEvidence: true,
      },
      seniorBuilder: {
        modelProfile: "worker",
        canEdit: true,
      },
      noSubagents: {
        canSpawnSubagents: false,
      },
    },
    agents: {
      "builder-01": {
        role: "builder",
        soul: "builder",
        repo: "app",
        portStart: 18471,
        reporting: {},
        identity: {npub: "", sec: "secret", bunkerProfile: "builder-01", nakClientKey: ""},
      },
    },
    ...patch,
  },
})

const prepared = (testApp: AppCfg, agentPatch: Partial<PreparedAgent["agent"]> = {}): PreparedAgent => {
  const agent = {...testApp.config.agents["builder-01"], ...agentPatch}
  return {
    app: testApp,
    id: "builder-01",
    configId: "builder-01",
    meta: {
      id: "builder-01",
      role: agent.role,
      soul: agent.soul,
      repo: agent.repo,
      description: "",
      capabilities: [],
    },
    agent,
    repo: testApp.config.repos.app,
    paths: {
      root: "/repo/runtime/agents/builder-01",
      workspace: "/repo/runtime/agents/builder-01/workspace",
      memory: "/repo/runtime/agents/builder-01/workspace/memory",
      tasks: "/repo/runtime/agents/builder-01/tasks",
      queue: "/repo/runtime/agents/builder-01/tasks/queue",
      history: "/repo/runtime/agents/builder-01/tasks/history",
      artifacts: "/repo/runtime/agents/builder-01/artifacts",
      browser: "/repo/runtime/agents/builder-01/browser",
      stateFile: "/repo/runtime/agents/builder-01/state.json",
    },
  }
}

describe("model profile resolution", () => {
  test("raw task model wins and can carry an explicit variant", () => {
    const selection = resolveModelSelection(prepared(app(), {modelProfile: "agent"}), {
      model: "provider/raw",
      modelProfile: "task",
      modelVariant: "max",
    })

    expect(selection).toEqual({
      model: "provider/raw",
      variant: "max",
      workerProfile: "builder",
      source: "task-model",
    })
  })

  test("task model profile wins over agent and worker defaults", () => {
    const selection = resolveModelSelection(prepared(app(), {modelProfile: "agent"}), {
      modelProfile: "task",
    })

    expect(selection.model).toBe("provider/task")
    expect(selection.variant).toBe("high")
    expect(selection.modelProfile).toBe("task")
    expect(selection.workerProfile).toBe("builder")
    expect(selection.source).toBe("task-model-profile")
  })

  test("agent model profile wins over worker profile", () => {
    const selection = resolveModelSelection(prepared(app(), {
      workerProfile: "seniorBuilder",
      modelProfile: "agent",
    }))

    expect(selection.model).toBe("provider/agent")
    expect(selection.modelProfile).toBe("agent")
    expect(selection.workerProfile).toBe("seniorBuilder")
    expect(selection.source).toBe("agent-model-profile")
  })

  test("explicit worker profile wins over role default worker profile", () => {
    const selection = resolveModelSelection(prepared(app(), {workerProfile: "seniorBuilder"}))

    expect(selection.model).toBe("provider/worker")
    expect(selection.modelProfile).toBe("worker")
    expect(selection.workerProfile).toBe("seniorBuilder")
    expect(selection.source).toBe("worker-profile")
  })

  test("explicit worker profile without a model can still use the role default model", () => {
    const selection = resolveModelSelection(prepared(app(), {workerProfile: "noSubagents"}))

    expect(selection.model).toBe("provider/role")
    expect(selection.modelProfile).toBe("role")
    expect(selection.workerProfile).toBe("noSubagents")
    expect(selection.source).toBe("role-default-worker-profile")
  })

  test("falls through role default, global profile, and raw opencode model", () => {
    expect(resolveModelSelection(prepared(app())).source).toBe("role-default-worker-profile")

    const globalOnly = app({
      opencode: {binary: "opencode", model: "fallback/model", agent: "build", modelProfile: "global"},
      workerProfiles: {},
    })
    expect(resolveModelSelection(prepared(globalOnly)).source).toBe("opencode-model-profile")
    expect(resolveModelSelection(prepared(globalOnly)).model).toBe("provider/global")

    const rawFallback = app({modelProfiles: {}, workerProfiles: {}})
    expect(resolveModelSelection(prepared(rawFallback))).toEqual({
      model: "fallback/model",
      variant: undefined,
      workerProfile: undefined,
      source: "opencode-model",
    })
  })

  test("throws clear errors for unknown profiles", () => {
    expect(() => resolveWorkerProfile(prepared(app(), {workerProfile: "missing"}))).toThrow("unknown worker profile")
    expect(() => resolveModelSelection(prepared(app(), {modelProfile: "missing"}))).toThrow("unknown model profile")
    expect(() => resolveModelSelection(prepared(app()), {modelProfile: "missing"})).toThrow("unknown model profile")
  })

  test("renders worker capability prompt lines", () => {
    const lines = workerProfilePromptLines(prepared(app(), {workerProfile: "noSubagents"})).join("\n")

    expect(lines).toContain("Worker profile: noSubagents")
    expect(lines).toContain("do not spawn opencode helper subagents")
  })
})
