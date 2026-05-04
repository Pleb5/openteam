import {describe, expect, test} from "bun:test"
import {mkdtemp, readFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {consolePrompt} from "../src/commands/console.js"
import {agentPaths, prepareAgent} from "../src/config.js"
import {validateAppConfig} from "../src/config-validate.js"
import type {AppCfg} from "../src/types.js"

const app = (patch: Partial<AppCfg["config"]> = {}): AppCfg => ({
  root: "/home/johnd/Work/openteam",
  config: {
    runtimeRoot: "/home/johnd/Work/openteam/runtime",
    opencode: {binary: "opencode", model: "", agent: "build"},
    browser: {
      headless: false,
      executablePath: "/usr/bin/chromium",
      mcp: {name: "playwright", command: ["bunx", "@playwright/mcp@latest"], environment: {}},
    },
    providers: {
      "github.com": {type: "github", host: "github.com", token: "token"},
    },
    repos: {
      app: {
        root: "/home/johnd/Work/openteam",
        baseBranch: "master",
        sharedPaths: [],
        mode: "web",
      },
    },
    reporting: {
      dmRelays: ["wss://relay.example.com"],
      outboxRelays: ["wss://relay.example.com"],
      relayListBootstrapRelays: ["wss://relay.damus.io"],
      appDataRelays: ["wss://relay.example.com"],
      signerRelays: ["wss://relay.example.com"],
      allowFrom: [],
      reportTo: [],
      pollIntervalMs: 5000,
    },
    nostr_git: {
      graspServers: [],
      gitDataRelays: ["wss://relay.example.com"],
      repoAnnouncementRelays: ["wss://relay.ngit.dev"],
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
        identity: {
          npub: "",
          sec: "secret",
          bunkerProfile: "builder-01",
          nakClientKey: "",
        },
        nostr_git: {},
      },
      "orchestrator-01": {
        role: "orchestrator",
        soul: "orchestrator",
        repo: "app",
        portStart: 18470,
        reporting: {},
        identity: {
          npub: "",
          sec: "secret",
          bunkerProfile: "orchestrator-01",
          nakClientKey: "",
        },
        nostr_git: {},
      },
    },
    ...patch,
  },
})

describe("config helpers", () => {
  test("builds stable runtime paths for an agent", () => {
    const app: AppCfg = {
      root: "/home/johnd/Work/openteam",
      config: {
        runtimeRoot: "/home/johnd/Work/openteam/runtime",
        opencode: {binary: "opencode", model: "", agent: "build"},
        browser: {
          headless: false,
          executablePath: "/usr/bin/chromium",
          mcp: {name: "playwright", command: [], environment: {}},
        },
        providers: {},
        repos: {},
        reporting: {
          dmRelays: [],
          outboxRelays: [],
          relayListBootstrapRelays: [],
          appDataRelays: [],
          signerRelays: [],
          allowFrom: [],
          reportTo: [],
          pollIntervalMs: 5000,
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
    }

    const paths = agentPaths(app, "builder-01")

    expect(paths.root).toBe("/home/johnd/Work/openteam/runtime/agents/builder-01")
    expect(paths.workspace).toBe("/home/johnd/Work/openteam/runtime/agents/builder-01/workspace")
    expect(paths.browser).toBe("/home/johnd/Work/openteam/runtime/agents/builder-01/browser")
    expect(paths.stateFile).toBe("/home/johnd/Work/openteam/runtime/agents/builder-01/state.json")
  })

  test("validates required web-mode browser configuration", () => {
    const result = validateAppConfig(app({
      browser: {
        headless: false,
        executablePath: "/usr/bin/chromium",
        mcp: {name: "playwright", command: [], environment: {}},
      },
    }), {capability: "launch", agentId: "builder-01", mode: "web"})

    expect(result.errors.some(item => item.code === "browser-mcp-command-missing")).toBe(true)
  })

  test("validates worker and model profile references", () => {
    const result = validateAppConfig(app({
      opencode: {binary: "opencode", model: "", agent: "build", modelProfile: "missing-global", roleAgents: "yes" as unknown as boolean},
      modelProfiles: {
        "builder-strong": {model: "provider/model", variant: "high"},
      },
      workerProfiles: {
        builder: {modelProfile: "missing-worker", opencodeAgent: ""},
      },
      agents: {
        ...app().config.agents,
        "builder-01": {
          ...app().config.agents["builder-01"],
          workerProfile: "missing-worker-profile",
          modelProfile: "missing-agent-profile",
          opencodeAgent: "",
        },
      },
    }))

    expect(result.errors.some(item => item.message.includes("opencode.modelProfile"))).toBe(true)
    expect(result.errors.some(item => item.code === "opencode-role-agents-invalid")).toBe(true)
    expect(result.errors.some(item => item.message.includes("worker profile 'builder'"))).toBe(true)
    expect(result.errors.some(item => item.code === "worker-profile-opencode-agent-empty")).toBe(true)
    expect(result.errors.some(item => item.message.includes("unknown worker profile 'missing-worker-profile'"))).toBe(true)
    expect(result.errors.some(item => item.message.includes("unknown model profile 'missing-agent-profile'"))).toBe(true)
    expect(result.errors.some(item => item.code === "agent-opencode-agent-empty")).toBe(true)
  })

  test("materializes NIP-34/Nostr-git collaboration vocabulary for agents", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const testApp = app({runtimeRoot})
    testApp.root = process.cwd()

    const agent = await prepareAgent(testApp, "builder-01")
    const agentsMd = await readFile(path.join(agent.paths.workspace, "AGENTS.md"), "utf8")
    const roleMd = await readFile(path.join(agent.paths.workspace, "ROLE.md"), "utf8")

    expect(agentsMd).toContain("NIP-34/Nostr-git")
    expect(agentsMd).toContain("GitHub/GitLab issues, PRs, or comments")
    expect(roleMd).toContain("NIP-34/Nostr-git")
    expect(roleMd).toContain("openteam repo publish")
    expect(roleMd).toContain("Final response contract")
    expect(roleMd).toContain("`Changed Files`")
  })

  test("console prompt keeps git collaboration vocabulary Nostr-git-first", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const testApp = app({runtimeRoot})
    testApp.root = process.cwd()

    const prompt = await consolePrompt(testApp)

    expect(prompt).toContain("Git collaboration vocabulary")
    expect(prompt).toContain("NIP-34/Nostr-git")
    expect(prompt).toContain("Issues are kind 1621")
    expect(prompt).toContain("Use GitHub/GitLab issue, PR, or comment systems only when the task explicitly names that forge")
  })

  test("validates required agent secret for launch", () => {
    const base = app()
    base.config.agents["builder-01"].identity.sec = ""

    const result = validateAppConfig(base, {capability: "launch", agentId: "builder-01", mode: "code"})

    expect(result.errors.some(item => item.code === "missing-agent-secret")).toBe(true)
  })

  test("validates relay URLs", () => {
    const result = validateAppConfig(app({
      reporting: {
        ...app().config.reporting,
        outboxRelays: ["not a relay url"],
      },
    }))

    expect(result.errors.some(item => item.code === "invalid-relay-url")).toBe(true)
  })

  test("validates profile sync relay and token readiness", () => {
    const result = validateAppConfig(app({
      providers: {},
      reporting: {
        ...app().config.reporting,
        appDataRelays: [],
      },
      nostr_git: {
        ...app().config.nostr_git,
        gitDataRelays: [],
      },
    }), {capability: "profile-sync", agentId: "builder-01"})

    expect(result.errors.some(item => item.code === "profile-relays-empty")).toBe(true)
    expect(result.errors.some(item => item.code === "provider-tokens-empty")).toBe(true)
  })

  test("validates verification runner references", () => {
    const result = validateAppConfig(app({
      verification: {
        defaultRunners: {code: ["missing-runner"]},
        runners: {},
      },
    }))

    expect(result.errors.some(item => item.code === "verification-runner-missing")).toBe(true)
  })

  test("warns when enabled browser verification has no MCP command", () => {
    const result = validateAppConfig(app({
      browser: {
        headless: false,
        executablePath: "/usr/bin/chromium",
        mcp: {name: "playwright", command: [], environment: {}},
      },
    }))

    expect(result.warnings.some(item => item.code === "verification-browser-runner-unavailable")).toBe(true)
  })

  test("accepts configured browser-cli verification runners", () => {
    const result = validateAppConfig(app({
      verification: {
        defaultRunners: {web: ["repo-native", "browser"]},
        runners: {
          "agent-browser": {
            kind: "browser-cli",
            enabled: true,
            local: true,
            modes: ["web"],
            stacks: ["web"],
            command: ["sh", "-c", "true"],
            artifactsDir: ".openteam/artifacts/verification/agent-browser",
          },
        },
      },
    }))

    expect(result.errors.some(item => item.code === "verification-runner-kind-invalid")).toBe(false)
    expect(result.warnings.some(item => item.code === "verification-browser-cli-runner-unavailable")).toBe(false)
  })

  test("warns when enabled browser-cli verification has no command", () => {
    const result = validateAppConfig(app({
      verification: {
        defaultRunners: {web: ["repo-native", "browser"]},
        runners: {
          "agent-browser": {
            kind: "browser-cli",
            enabled: true,
            local: true,
            modes: ["web"],
            stacks: ["web"],
            command: [],
          },
        },
      },
    }))

    expect(result.warnings.some(item => item.code === "verification-browser-cli-runner-unavailable")).toBe(true)
  })

  test("validates optional agent-browser OpenCode tool config", () => {
    const result = validateAppConfig(app({
      browser: {
        headless: false,
        executablePath: "/usr/bin/chromium",
        agentBrowserTools: {
          enabled: true,
          command: "agent-browser",
          allowedDomains: ["127.0.0.1", "bad domain"],
          maxOutputChars: -1,
        },
        mcp: {name: "playwright", command: ["bunx", "@playwright/mcp@latest"], environment: {}},
      },
    }))

    expect(result.errors.some(item => item.code === "agent-browser-tools-domain-invalid")).toBe(true)
    expect(result.errors.some(item => item.code === "agent-browser-tools-max-output-invalid")).toBe(true)
  })
})
