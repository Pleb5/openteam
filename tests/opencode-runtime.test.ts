import {describe, expect, test} from "bun:test"
import {Database} from "bun:sqlite"
import {mkdir, mkdtemp, readFile, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {detectOpenCodeBlockedState, detectOpenCodeHardFailure} from "../src/opencode-log.js"
import {buildOpenCodeRuntimeHandoff, splitOpencodeModel, writeOpenCodeRuntimeHandoff} from "../src/opencode-runtime.js"
import {inspectOpenCodeDbState, openCodeRuntimeStateHardFailure} from "../src/opencode-state.js"
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
        modelAttemptPlan: [{
          model: "openai/gpt-5.5",
          variant: "xhigh",
          modelProfile: "builder",
          source: "worker-profile",
          planIndex: 0,
          fallbackKind: "primary",
          provider: "openai",
          modelId: "gpt-5.5",
        }],
      })

      expect(handoff.provider).toBe("openai")
      expect(handoff.modelId).toBe("gpt-5.5")
      expect(handoff.selectedModelAvailable).toBe(true)
      expect(handoff.attemptPlan?.at(0)?.model).toBe("openai/gpt-5.5")
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

const createStateDb = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "openteam-opencode-state-db-"))
  const file = path.join(dir, "opencode.db")
  const db = new Database(file)
  db.query("create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null)").all()
  db.query("create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null)").all()
  return {file, db}
}

const insertMessage = (db: Database, row: {id: string; role: string; time: number; provider?: string; model?: string; finish?: string}) => {
  db.query("insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)").all(row.id, "ses_1", row.time, row.time, JSON.stringify({
    role: row.role,
    providerID: row.provider,
    modelID: row.model,
    finish: row.finish,
    time: {created: row.time},
  }))
}

const insertPart = (db: Database, row: {id: string; messageId: string; type: string; data?: Record<string, unknown>; time: number}) => {
  db.query("insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)").all(row.id, row.messageId, "ses_1", row.time, row.time, JSON.stringify(row.data ?? {type: row.type}))
}

describe("opencode runtime state inspection", () => {
  test("classifies completed tool followed by incomplete assistant step as model-stream-stalled-after-tool", async () => {
    const nowMs = Date.now()
    const {file, db} = await createStateDb()
    try {
      insertMessage(db, {id: "m1", role: "assistant", time: nowMs - 87 * 60_000, finish: "tool-calls"})
      insertPart(db, {id: "p1", messageId: "m1", type: "tool", time: nowMs - 86 * 60_000 - 30_000, data: {type: "tool", tool: "read", state: {status: "completed", input: {path: ".openteam/task.json"}, title: "Read .openteam/task.json"}}})
      insertMessage(db, {id: "m2", role: "assistant", time: nowMs - 86 * 60_000, provider: "openai", model: "gpt-5.5"})
      insertPart(db, {id: "p2", messageId: "m2", type: "step-start", time: nowMs - 86 * 60_000, data: {type: "step-start"}})
      insertPart(db, {id: "p3", messageId: "m2", type: "reasoning", time: nowMs - 86 * 60_000 + 100, data: {type: "reasoning", text: "thinking", time: {start: nowMs - 86 * 60_000 + 100}}})

      const state = await inspectOpenCodeDbState(file, {nowMs, stallThresholdMs: 10_000})
      expect(state.kind).toBe("model-stream-stalled-after-tool")
      expect(state.lastCompletedTool).toEqual({name: "read", inputPath: ".openteam/task.json", status: "completed"})
      expect(state.evidence).toContain("lastCompletedTool=read .openteam/task.json")
      expect(state.evidence).toContain("provider=openai")
    } finally {
      db.close()
    }
  })

  test("classifies unfinished tool part as tool-in-flight", async () => {
    const nowMs = Date.now()
    const {file, db} = await createStateDb()
    try {
      insertMessage(db, {id: "m1", role: "assistant", time: nowMs - 60_000})
      insertPart(db, {id: "p1", messageId: "m1", type: "tool", time: nowMs - 50_000, data: {type: "tool", tool: "bash", state: {status: "running", input: {path: "tests"}}}})

      const state = await inspectOpenCodeDbState(file, {nowMs, stallThresholdMs: 10_000})
      expect(state.kind).toBe("tool-in-flight")
      expect(state.activeTool?.name).toBe("bash")
    } finally {
      db.close()
    }
  })

  test("returns unknown-idle when database is missing", async () => {
    const state = await inspectOpenCodeDbState(path.join(tmpdir(), "missing-opencode.db"))
    expect(state.kind).toBe("unknown-idle")
  })

  test("permission text detection still wins at log classification layer", () => {
    const blocked = detectOpenCodeBlockedState("permission requested: bash rm -rf /tmp/nope")
    expect(blocked?.kind).toBe("permission")
  })

  test("model-provider-stream-stalled is retryable and fallback eligible", () => {
    const hardFailure = detectOpenCodeHardFailure("Error: model-provider-stream-stalled: OpenCode model response stream stalled after last completed tool; provider=openai")
    expect(hardFailure?.category).toBe("model-provider-stream-stalled")
    expect(hardFailure?.retryable).toBe(true)
    expect(hardFailure?.fallbackEligible).toBe(true)
  })

  test("runtime state synthesizes retryable stream-stalled hard failure", async () => {
    const failure = openCodeRuntimeStateHardFailure({kind: "model-stream-stalled", messageAgeMs: 60_000, evidence: "provider=openai"})
    expect(failure?.category).toBe("model-provider-stream-stalled")
    expect(failure?.retryable).toBe(true)
    expect(failure?.fallbackEligible).toBe(true)
  })
})
