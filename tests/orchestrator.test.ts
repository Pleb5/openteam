import {describe, expect, test} from "bun:test"
import {mkdtemp} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {dispatchOperatorRequest, parseOperatorRequest} from "../src/orchestrator.js"
import type {AppCfg} from "../src/types.js"

const makeApp = (runtimeRoot: string): AppCfg => ({
  root: process.cwd(),
  config: {
    runtimeRoot,
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
})

describe("orchestrator operator request parsing", () => {
  test("parses researcher work requests", () => {
    expect(parseOperatorRequest(
      "work on nostr://npub1example/repo as researcher in code mode with model openai/gpt-5.4 in parallel and do compare implementation options",
    )).toEqual({
      kind: "work",
      target: "nostr://npub1example/repo",
      role: "researcher",
      mode: "code",
      model: "openai/gpt-5.4",
      parallel: true,
      task: "compare implementation options",
    })
  })

  test("parses research shortcut as researcher code task", () => {
    expect(parseOperatorRequest(
      "research nostr://npub1example/repo and identify the safest fix direction",
    )).toEqual({
      kind: "research",
      target: "nostr://npub1example/repo",
      role: "researcher",
      mode: "code",
      model: undefined,
      parallel: false,
      task: "identify the safest fix direction",
    })
  })

  test("parses plan shortcut as researcher plan task", () => {
    expect(parseOperatorRequest(
      "plan 30617:abc:repo in web mode and produce a builder handoff",
    )).toEqual({
      kind: "research",
      target: "30617:abc:repo",
      role: "researcher",
      mode: "web",
      model: undefined,
      parallel: false,
      task: "Produce a research-backed implementation plan: produce a builder handoff",
    })
  })

  test("parses manual takeover requests", () => {
    expect(parseOperatorRequest("take over builder-01-task-a")).toEqual({
      kind: "takeover",
      runId: "builder-01-task-a",
    })
  })

  test("status dispatch uses operator runtime status", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    const result = await dispatchOperatorRequest(app, "status")

    expect(result.handled).toBe(true)
    expect(result.summary).toBe("status: 0/0 managed workers live, 0 recent runs, 0 stale runs")
    expect(result.message).toContain("managed workers: 0 live / 0 total")
    expect(result.message).toContain("recent runs: 0 running, 0 stale / 0 total")
  })

  test("help dispatch returns fast DM command grammar", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-runtime-")))
    const result = await dispatchOperatorRequest(app, "help")

    expect(result.handled).toBe(true)
    expect(result.summary).toBe("listed DM commands")
    expect(result.message).toContain("openteam DM commands")
    expect(result.message).toContain("work on <target>")
    expect(result.message).toContain("Anything else falls back")
  })
})
