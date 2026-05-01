import {describe, expect, test} from "bun:test"
import {readFile} from "node:fs/promises"
import path from "node:path"
import {
  buildCodeWorkerPrompt,
  buildProvisioningPrompt,
  buildWebWorkerPrompt,
  roleOutputContractLines,
} from "../src/worker-prompts.js"
import type {AppCfg, PreparedAgent} from "../src/types.js"

const app = (): AppCfg => ({
  root: "/repo",
  config: {
    runtimeRoot: "/repo/runtime",
    opencode: {binary: "opencode", model: "", agent: "build"},
    browser: {
      headless: false,
      mcp: {name: "playwright", command: [], environment: {}},
    },
    providers: {},
    repos: {
      app: {
        root: "/repo/app",
        baseBranch: "main",
        sharedPaths: [],
        mode: "web",
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

const agent = (role: string): PreparedAgent => {
  const testApp = app()
  const repo = testApp.config.repos.app
  const id = `${role}-01`

  return {
    app: testApp,
    id,
    configId: id,
    meta: {
      id,
      role,
      soul: role,
      repo: "app",
      description: "",
      capabilities: [],
    },
    agent: {
      role,
      soul: role,
      repo: "app",
      portStart: 18471,
      reporting: {},
      identity: {
        npub: "",
        sec: "",
        bunkerProfile: id,
        nakClientKey: "",
      },
      nostr_git: {},
    },
    repo,
    paths: {
      root: "/repo/runtime/agents/test",
      workspace: "/repo/runtime/agents/test/workspace",
      memory: "/repo/runtime/agents/test/workspace/MEMORY.md",
      tasks: "/repo/runtime/agents/test/tasks",
      queue: "/repo/runtime/agents/test/queue",
      history: "/repo/runtime/agents/test/history",
      artifacts: "/repo/runtime/agents/test/artifacts",
      browser: "/repo/runtime/agents/test/browser",
      stateFile: "/repo/runtime/agents/test/state.json",
    },
  }
}

describe("worker prompt contracts", () => {
  test("exposes concise role-specific final response labels", () => {
    const contract = roleOutputContractLines("builder").join("\n")

    expect(contract).toContain("Final response contract")
    expect(contract).toContain("`Changed Files`")
    expect(contract).toContain("`Verification`")
    expect(contract).toContain("`Publication Readiness`")
  })

  test("keeps provisioning prompt in worker handoff mode", () => {
    const prompt = buildProvisioningPrompt(agent("orchestrator"), "prepare the repo")

    expect(prompt).toContain("You are running in provisioning mode")
    expect(prompt).toContain("Structured task manifest: .openteam/task.json")
    expect(prompt).toContain("Do not call openteam launch")
    expect(prompt).toContain("Worker handoff target task: prepare the repo")
  })

  test("adds builder output contract to code-first worker prompts", () => {
    const prompt = buildCodeWorkerPrompt(agent("builder"), "fix the failing test")

    expect(prompt).toContain("This run is code-first")
    expect(prompt).toContain("Read .openteam/task.json before starting")
    expect(prompt).toContain("Opencode helper subagents available through the Task tool")
    expect(prompt).toContain("openteam-review")
    expect(prompt).toContain("Final response contract")
    expect(prompt).toContain("`Changed Files`")
    expect(prompt).toContain("`Verification`")
    expect(prompt).toContain("needs-review")
    expect(prompt).toContain("normal PR publication is blocked until evidence is strong")
    expect(prompt).not.toContain("Local app URL")
  })

  test("applies worker profile prompt policy and can hide helper subagents", () => {
    const prepared = agent("builder")
    prepared.app.config.workerProfiles = {
      builder: {
        canEdit: false,
        canSpawnSubagents: false,
      },
    }
    const prompt = buildCodeWorkerPrompt(prepared, "inspect the bug")

    expect(prompt).toContain("Worker profile: builder")
    expect(prompt).toContain("do not edit product source files")
    expect(prompt).toContain("do not spawn opencode helper subagents")
    expect(prompt).not.toContain("Opencode helper subagents available through the Task tool")
  })

  test("adds QA output contract and browser evidence instructions to web prompts", () => {
    const prompt = buildWebWorkerPrompt(
      agent("qa"),
      "test the login flow",
      "http://127.0.0.1:1234",
      {bunker: {uri: "bunker://test"}},
    )

    expect(prompt).toContain("Local app URL: http://127.0.0.1:1234")
    expect(prompt).toContain("Structured task manifest: .openteam/task.json")
    expect(prompt).toContain("openteam-qa-flow")
    expect(prompt).toContain("Remote signer bunker URL: bunker://test")
    expect(prompt).toContain("openteam verify browser")
    expect(prompt).toContain("`Scope`")
    expect(prompt).toContain("`Evidence`")
    expect(prompt).toContain("`Verdict`")
    expect(prompt).toContain("needs-review")
  })

  test("documents the researcher write boundary in the role file", async () => {
    const role = await readFile(path.join(process.cwd(), "roles", "researcher.md"), "utf8")

    expect(role).toContain("do not modify product source, config, lockfiles, tests, branches, commits, or PRs")
    expect(role).toContain("only write structured `openteam verify` evidence")
    expect(role).toContain("`Recommendation`")
    expect(role).toContain("`Handoff`")
  })
})
