import {describe, expect, test} from "bun:test"
import {parseInboundDmEvents} from "../src/dm.js"
import {operatorMessageFromLogText} from "../src/launcher.js"
import {encryptFor, getSelfPubkey, splitDmBody} from "../src/nostr.js"
import type {PreparedAgent} from "../src/types.js"

const receiverSec = "1111111111111111111111111111111111111111111111111111111111111111"
const senderSec = "2222222222222222222222222222222222222222222222222222222222222222"

const makeAgent = (id: string, sec: string): PreparedAgent => ({
  id,
  configId: id,
  meta: {
    id,
    role: "orchestrator",
    soul: "orchestrator",
    repo: "control",
    description: "test agent",
    capabilities: [],
  },
  agent: {
    role: "orchestrator",
    soul: "orchestrator",
    repo: "control",
    portStart: 18470,
    reporting: {
      dmRelays: ["wss://dm.example.com"],
      outboxRelays: [],
      relayListBootstrapRelays: [],
      appDataRelays: [],
      signerRelays: [],
      reportTo: [],
      allowFrom: [],
    },
    identity: {
      npub: "",
      sec,
      bunkerProfile: id,
      nakClientKey: "",
    },
    nostr_git: {},
  },
  repo: {
    root: "/tmp/control",
    baseBranch: "main",
    devCommand: [],
    healthUrl: "",
    sharedPaths: [],
  },
  paths: {
    root: "/tmp/runtime/agents/test",
    workspace: "/tmp/runtime/agents/test/workspace",
    memory: "/tmp/runtime/agents/test/workspace/memory",
    tasks: "/tmp/runtime/agents/test/tasks",
    queue: "/tmp/runtime/agents/test/tasks/queue",
    history: "/tmp/runtime/agents/test/tasks/history",
    artifacts: "/tmp/runtime/agents/test/artifacts",
    browser: "/tmp/runtime/agents/test/browser",
    stateFile: "/tmp/runtime/agents/test/state.json",
  },
  app: {
    root: "/tmp/openteam",
    config: {
      runtimeRoot: "/tmp/openteam/runtime",
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
  },
})

describe("DM intake", () => {
  test("deduplicates repeated deliveries of the same event id", () => {
    const receiver = makeAgent("orchestrator-01", receiverSec)
    const sender = makeAgent("operator", senderSec)
    const receiverPubkey = getSelfPubkey(receiver)
    const senderPubkey = getSelfPubkey(sender)
    const seen = new Set<string>()
    const event = {
      id: "event-a",
      pubkey: senderPubkey,
      created_at: 1,
      content: encryptFor(sender, receiverPubkey, "status"),
    }

    const messages = parseInboundDmEvents(
      receiver,
      new Set([senderPubkey]),
      receiverPubkey,
      seen,
      [event, event],
    )

    expect(messages).toHaveLength(1)
    expect(messages[0]?.body).toBe("status")
    expect(seen.has("event-a")).toBe(true)
  })

  test("preserves long inbound bodies after decryption", () => {
    const receiver = makeAgent("orchestrator-01", receiverSec)
    const sender = makeAgent("operator", senderSec)
    const receiverPubkey = getSelfPubkey(receiver)
    const senderPubkey = getSelfPubkey(sender)
    const longBody = `please investigate\n${"0123456789abcdef".repeat(900)}`

    const messages = parseInboundDmEvents(
      receiver,
      new Set([senderPubkey]),
      receiverPubkey,
      new Set<string>(),
      [{
        id: "event-long",
        pubkey: senderPubkey,
        created_at: 1,
        content: encryptFor(sender, receiverPubkey, longBody),
      }],
    )

    expect(messages).toHaveLength(1)
    expect(messages[0]?.body).toBe(longBody)
  })

  test("splits long outbound DM reports into ordered byte-safe chunks", () => {
    const body = `intro\n${"0123456789".repeat(20)}\n${"\u00e9".repeat(20)}`
    const chunks = splitDmBody(body, 80)
    const encoder = new TextEncoder()

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(encoder.encode(chunk).length).toBeLessThanOrEqual(80)
    }
    expect(chunks[0]).toMatch(/^\[1\/\d+\]\n/)
    expect(chunks.map(chunk => chunk.replace(/^\[\d+\/\d+\]\n/, "")).join("")).toBe(body)
  })

  test("keeps full explicit operator messages from logs", () => {
    const longMessage = "x".repeat(3200)
    const log = `noise before\nOPENTEAM_OPERATOR_MESSAGE:${longMessage}\n`

    expect(operatorMessageFromLogText(log)).toBe(longMessage)
  })
})
