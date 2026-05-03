import {describe, expect, test} from "bun:test"
import {mkdir, mkdtemp, readFile, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {
  opencodeHelperAgentPath,
  opencodeHelperAgentPromptLines,
  opencodeHelperAgents,
  opencodePrimaryAgentName,
  opencodePrimaryAgentPath,
  selectOpencodePrimaryAgent,
  writeOpencodeManagedAgents,
  writeOpencodeHelperAgents,
} from "../src/opencode-agents.js"
import type {AppCfg, PreparedAgent} from "../src/types.js"

const tempCheckout = async () => {
  return await mkdtemp(path.join(tmpdir(), "openteam-opencode-agents-"))
}

const app = (): AppCfg => ({
  root: "/repo",
  config: {
    runtimeRoot: "/repo/runtime",
    opencode: {binary: "opencode", model: "", agent: "build", roleAgents: true},
    browser: {
      headless: false,
      mcp: {name: "playwright", command: [], environment: {}},
    },
    providers: {},
    repos: {
      app: {root: "/repo/app", baseBranch: "main", sharedPaths: [], mode: "code"},
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
    workerProfiles: {
      builder: {
        canEdit: true,
        canPublishPr: true,
        canUseBrowser: true,
        canSpawnSubagents: true,
        requiresEvidence: true,
      },
      researcher: {
        canEdit: false,
        canPublishPr: false,
        canUseBrowser: false,
        canSpawnSubagents: true,
        requiresEvidence: false,
      },
    },
    agents: {},
  },
})

const prepared = (role = "builder", testApp = app()): PreparedAgent => ({
  app: testApp,
  id: `${role}-01`,
  configId: `${role}-01`,
  meta: {
    id: `${role}-01`,
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
    identity: {npub: "", sec: "secret", bunkerProfile: `${role}-01`, nakClientKey: ""},
  },
  repo: testApp.config.repos.app,
  paths: {
    root: `/repo/runtime/agents/${role}-01`,
    workspace: `/repo/runtime/agents/${role}-01/workspace`,
    memory: `/repo/runtime/agents/${role}-01/workspace/memory`,
    tasks: `/repo/runtime/agents/${role}-01/tasks`,
    queue: `/repo/runtime/agents/${role}-01/tasks/queue`,
    history: `/repo/runtime/agents/${role}-01/tasks/history`,
    artifacts: `/repo/runtime/agents/${role}-01/artifacts`,
    browser: `/repo/runtime/agents/${role}-01/browser`,
    stateFile: `/repo/runtime/agents/${role}-01/state.json`,
  },
})

describe("opencode helper agents", () => {
  test("defines the expected tactical helper agents", () => {
    expect(opencodeHelperAgents.map(agent => agent.name)).toEqual([
      "openteam-explore",
      "openteam-review",
      "openteam-qa-flow",
      "openteam-dependency",
    ])
  })

  test("writes read-only markdown subagents under .opencode/agent", async () => {
    const checkout = await tempCheckout()
    const files = await writeOpencodeHelperAgents(checkout)

    expect(files).toHaveLength(4)
    for (const agent of opencodeHelperAgents) {
      const file = opencodeHelperAgentPath(checkout, agent.name)
      const text = await readFile(file, "utf8")

      expect(files).toContain(file)
      expect(text).toContain("mode: subagent")
      expect(text).toContain(`description: ${JSON.stringify(agent.description)}`)
      expect(text).toContain(`"*": deny`)
      expect(text).toContain("read: allow")
      expect(text).toContain("grep: allow")
      expect(text).toContain("glob: allow")
      expect(text).toContain("Stay read-only")
      expect(text).toContain("Do not call openteam launch")
      expect(text).toContain("The parent worker owns edits, verification, publication")
    }
  })

  test("does not delete project-defined opencode agents", async () => {
    const checkout = await tempCheckout()
    const custom = path.join(checkout, ".opencode", "agent", "custom.md")
    await mkdir(path.dirname(custom), {recursive: true})
    await writeFile(custom, "---\ndescription: custom\n---\n\ncustom agent\n")

    await writeOpencodeHelperAgents(checkout)

    expect(await readFile(custom, "utf8")).toContain("custom agent")
  })

  test("writes role-specific primary agents under .opencode/agent", async () => {
    const checkout = await tempCheckout()
    const files = await writeOpencodeManagedAgents(prepared("builder"), checkout)
    const builder = await readFile(opencodePrimaryAgentPath(checkout, "builder"), "utf8")
    const researcher = await readFile(opencodePrimaryAgentPath(checkout, "researcher"), "utf8")
    const qa = await readFile(opencodePrimaryAgentPath(checkout, "qa"), "utf8")
    const triager = await readFile(opencodePrimaryAgentPath(checkout, "triager"), "utf8")
    const orchestrator = await readFile(opencodePrimaryAgentPath(checkout, "orchestrator"), "utf8")

    expect(files).toContain(opencodePrimaryAgentPath(checkout, "builder"))
    expect(builder).toContain("mode: primary")
    expect(builder).toContain("You are openteam-builder")
    expect(builder).toContain("question: deny")
    expect(builder).toContain("Do not ask interactive questions")
    expect(builder).toContain("Do not reason about orchestration lifecycle tasks")
    expect(builder).toContain("canEdit: true")
    expect(builder).toContain("Final response contract")
    expect(builder).toContain("- Changed Files:")
    expect(researcher).toContain("mode: primary")
    expect(researcher).toContain("edit: deny")
    expect(researcher).toContain("bash:")
    expect(researcher).toContain(`"*": deny`)
    expect(researcher).toContain(`"openteam verify *": allow`)
    expect(researcher).toContain(`"openteam repo policy *": allow`)
    expect(researcher).toContain("Do not modify product source")
    expect(qa).toContain("edit: deny")
    expect(qa).toContain(`"*": deny`)
    expect(qa).toContain(`"openteam verify *": allow`)
    expect(triager).toContain("edit: deny")
    expect(triager).toContain(`"*": deny`)
    expect(triager).toContain(`"openteam verify *": allow`)
    expect(builder).not.toContain(`"*": deny`)
    expect(orchestrator).toContain("question: allow")
    expect(orchestrator).toContain("You may ask concise operator questions")
  })

  test("primary agent permissions reflect worker profile capability overrides", async () => {
    const checkout = await tempCheckout()
    const testApp = app()
    testApp.config.workerProfiles = {
      builder: {
        canEdit: false,
        canPublishPr: false,
        canUseBrowser: false,
        canSpawnSubagents: false,
        requiresEvidence: true,
      },
    }

    await writeOpencodeManagedAgents(prepared("builder", testApp), checkout)
    const builder = await readFile(opencodePrimaryAgentPath(checkout, "builder"), "utf8")

    expect(builder).toContain("edit: deny")
    expect(builder).toContain("task: deny")
    expect(builder).toContain(`"*": deny`)
    expect(builder).toContain(`"openteam verify *": allow`)
    expect(builder).toContain(`"openteam repo publish pr*": deny`)
    expect(builder).toContain("canSpawnSubagents: false")
  })

  test("selects role-specific primary agents only when enabled or explicitly configured", () => {
    const enabled = prepared("builder")
    expect(opencodePrimaryAgentName("builder")).toBe("openteam-builder")
    expect(selectOpencodePrimaryAgent(enabled)).toBe("openteam-builder")

    const disabledApp = app()
    disabledApp.config.opencode.roleAgents = false
    expect(selectOpencodePrimaryAgent(prepared("builder", disabledApp))).toBe("build")

    const explicitApp = app()
    explicitApp.config.opencode.roleAgents = false
    const explicit = prepared("builder", explicitApp)
    explicit.agent.opencodeAgent = "custom-builder"
    expect(selectOpencodePrimaryAgent(explicit)).toBe("custom-builder")
  })

  test("summarizes helper use in role-aware worker prompts", () => {
    const builder = opencodeHelperAgentPromptLines("builder").join("\n")
    const qa = opencodeHelperAgentPromptLines("qa").join("\n")

    expect(builder).toContain("openteam-explore")
    expect(builder).toContain("openteam-review")
    expect(builder).toContain("Task tool")
    expect(builder).toContain("do not create openteam run records")
    expect(qa).toContain("openteam-qa-flow")
    expect(qa).toContain("QA hint")
  })
})
