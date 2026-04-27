import {describe, expect, test} from "bun:test"
import {agentPaths} from "../src/config.js"
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
})
