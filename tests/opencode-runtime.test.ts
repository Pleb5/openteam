import {describe, expect, test} from "bun:test"
import {mkdir, mkdtemp, readFile, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {buildOpenCodeRuntimeHandoff, splitOpencodeModel, writeOpenCodeRuntimeHandoff} from "../src/opencode-runtime.js"
import type {AppCfg} from "../src/types.js"

const app = (): AppCfg => ({
  root: "/repo",
  config: {
    runtimeRoot: "/repo/runtime",
    opencode: {binary: "opencode", model: "openai/fallback", agent: "build"},
    browser: {headless: true, mcp: {name: "playwright", command: [], environment: {}}},
    providers: {},
    repos: {app: {root: "/repo", baseBranch: "main", sharedPaths: [], mode: "code"}},
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
      builder: {model: "openai/gpt-5.5", variant: "xhigh"},
      research: {model: "openai/gpt-5.5", variant: "medium"},
    },
    agents: {},
  },
})

describe("opencode runtime handoff", () => {
  test("splits provider/model references", () => {
    expect(splitOpencodeModel("openai/gpt-5.5")).toEqual({provider: "openai", modelId: "gpt-5.5"})
    expect(splitOpencodeModel("badmodel")).toEqual({modelId: "badmodel"})
  })

  test("records sanitized auth and configured model status", async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-opencode-runtime-checkout-"))
    const data = await mkdtemp(path.join(tmpdir(), "openteam-opencode-data-"))
    const state = await mkdtemp(path.join(tmpdir(), "openteam-opencode-state-"))
    await writeFile(path.join(data, "auth.json"), "{}\n")
    await writeFile(path.join(state, "model.json"), "{}\n")
    await writeFile(path.join(state, "kv.json"), "{}\n")

    const oldData = process.env.OPENTEAM_OPENCODE_SOURCE_DATA_DIR
    const oldState = process.env.OPENTEAM_OPENCODE_SOURCE_STATE_DIR
    process.env.OPENTEAM_OPENCODE_SOURCE_DATA_DIR = data
    process.env.OPENTEAM_OPENCODE_SOURCE_STATE_DIR = state
    try {
      const handoff = buildOpenCodeRuntimeHandoff({
        app: app(),
        checkout,
        binary: "runtime/opencode-with-user-state.sh",
        opencodeAgent: "openteam-builder",
        modelSelection: {
          model: "openai/gpt-5.5",
          variant: "xhigh",
          modelProfile: "builder",
          source: "worker-profile",
        },
      })

      expect(handoff.provider).toBe("openai")
      expect(handoff.modelId).toBe("gpt-5.5")
      expect(handoff.selectedModelAvailable).toBe(true)
      expect(handoff.auth.status).toBe("ready")
      expect(JSON.stringify(handoff)).not.toContain(data)
      expect(JSON.stringify(handoff)).not.toContain(state)
    } finally {
      if (oldData === undefined) delete process.env.OPENTEAM_OPENCODE_SOURCE_DATA_DIR
      else process.env.OPENTEAM_OPENCODE_SOURCE_DATA_DIR = oldData
      if (oldState === undefined) delete process.env.OPENTEAM_OPENCODE_SOURCE_STATE_DIR
      else process.env.OPENTEAM_OPENCODE_SOURCE_STATE_DIR = oldState
    }
  })

  test("writes checkout-local handoff files", async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-opencode-runtime-checkout-"))
    await mkdir(path.join(checkout, ".openteam"), {recursive: true})
    const handoff = await writeOpenCodeRuntimeHandoff({
      app: app(),
      checkout,
      binary: "opencode",
      opencodeAgent: "openteam-researcher",
      modelSelection: {model: "openai/gpt-5.5", variant: "medium", modelProfile: "research", source: "worker-profile"},
    })

    expect(handoff.files.json).toBe(path.join(checkout, ".openteam", "opencode-runtime.json"))
    expect(await readFile(handoff.files.json, "utf8")).toContain("openteam-researcher")
    expect(await readFile(handoff.files.summary, "utf8")).toContain("Do not inspect raw host OpenCode auth files")
  })
})
