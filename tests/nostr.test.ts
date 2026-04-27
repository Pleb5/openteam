import {describe, expect, test} from "bun:test"
import {getPublicKey, nip19} from "nostr-tools"
import {
  allowFrom,
  dmRelays,
  profileRelays,
  getSelfNpub,
  outboxRelays,
  relayTagValues,
  relayListBootstrapRelays,
  relayListDiscoveryRelays,
  relayListPublishRelays,
  signerRelays,
} from "../src/nostr.js"
import type {PreparedAgent} from "../src/types.js"

const makeAgent = (): PreparedAgent => {
  const sec = "1111111111111111111111111111111111111111111111111111111111111111"

  return {
    id: "builder-01",
    meta: {
      id: "builder-01",
      role: "builder",
      soul: "builder",
      repo: "app",
      description: "test agent",
      capabilities: [],
    },
    agent: {
      role: "builder",
      soul: "builder",
      repo: "app",
      portStart: 18471,
      reporting: {
        dmRelays: ["wss://dm.example.com"],
        outboxRelays: ["wss://outbox.example.com"],
        relayListBootstrapRelays: ["wss://bootstrap.example.com"],
        appDataRelays: ["wss://app.example.com", "wss://outbox.example.com"],
        signerRelays: ["wss://signer.example.com"],
        reportTo: [],
      },
      identity: {
        npub: "",
        sec,
        bunkerProfile: "builder-01",
        nakClientKey: "",
      },
      nostr_git: {
        graspServers: ["wss://example-grasp.server"],
        gitDataRelays: ["wss://git-a.example.com", "wss://app.example.com"],
        repoAnnouncementRelays: [],
        forkGitOwner: "",
        forkRepoPrefix: "",
        forkCloneUrlTemplate: "",
      },
    },
    repo: {
      root: "/tmp/app",
      baseBranch: "dev",
      devCommand: [],
      healthUrl: "http://127.0.0.1:{port}",
      sharedPaths: [],
    },
    paths: {
      root: "/tmp/runtime/agents/builder-01",
      workspace: "/tmp/runtime/agents/builder-01/workspace",
      memory: "/tmp/runtime/agents/builder-01/workspace/memory",
      tasks: "/tmp/runtime/agents/builder-01/tasks",
      queue: "/tmp/runtime/agents/builder-01/tasks/queue",
      history: "/tmp/runtime/agents/builder-01/tasks/history",
      artifacts: "/tmp/runtime/agents/builder-01/artifacts",
      browser: "/tmp/runtime/agents/builder-01/browser",
      stateFile: "/tmp/runtime/agents/builder-01/state.json",
    },
    app: {
      root: "/tmp/openteam",
      config: {
        runtimeRoot: "/tmp/openteam/runtime",
        opencode: {
          binary: "opencode",
          model: "",
          agent: "build",
        },
        browser: {
          headless: false,
          executablePath: "/usr/bin/chromium",
          mcp: {
            name: "playwright",
            command: [],
            environment: {},
          },
        },
        providers: {},
        repos: {},
        reporting: {
          dmRelays: [],
          outboxRelays: [],
          relayListBootstrapRelays: [],
          appDataRelays: [],
          signerRelays: [],
          allowFrom: ["npub1globalallowedexample000000000000000000000000000000000000000000000000000"],
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
  }
}

describe("nostr relay selection", () => {
  test("derives npub from secret key when missing", () => {
    const agent = makeAgent()
    const expected = nip19.npubEncode(getPublicKey(new Uint8Array(Buffer.from(agent.agent.identity.sec, "hex"))))
    expect(getSelfNpub(agent)).toBe(expected)
  })

  test("uses outbox and bootstrap relays for relay-list publishing, not dm relays", () => {
    const agent = makeAgent()

    expect(outboxRelays(agent)).toEqual(["wss://outbox.example.com"])
    expect(dmRelays(agent)).toEqual(["wss://dm.example.com"])
    expect(relayListBootstrapRelays(agent)).toEqual(["wss://bootstrap.example.com"])
    expect(relayListPublishRelays(agent)).toEqual([
      "wss://outbox.example.com",
      "wss://bootstrap.example.com",
    ])
    expect(relayListDiscoveryRelays(agent)).toEqual([
      "wss://outbox.example.com",
      "wss://bootstrap.example.com",
    ])
  })

  test("merges standard app-data relays with git-data relays", () => {
    const agent = makeAgent()

    expect(profileRelays(agent)).toEqual([
      "wss://app.example.com",
      "wss://outbox.example.com",
      "wss://git-a.example.com",
    ])
  })

  test("falls back to global allowFrom when agent override is absent", () => {
    const agent = makeAgent()
    expect(allowFrom(agent)).toEqual(["npub1globalallowedexample000000000000000000000000000000000000000000000000000"])

    agent.agent.reporting.allowFrom = ["npub1agentoverride0000000000000000000000000000000000000000000000000000"]
    expect(allowFrom(agent)).toEqual(["npub1agentoverride0000000000000000000000000000000000000000000000000000"])
  })

  test("reads DM relay list compatibility tags", () => {
    expect(relayTagValues([
      ["relay", "wss://dm.example.com"],
      ["r", "wss://dm.example.com"],
      ["r", "wss://other.example.com"],
      ["p", "not-a-relay"],
    ])).toEqual(["wss://dm.example.com", "wss://other.example.com"])
  })
})
