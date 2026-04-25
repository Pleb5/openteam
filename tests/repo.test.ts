import {describe, expect, test} from "bun:test"
import {mkdtemp, mkdir, readFile, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {getPublicKey, nip19} from "nostr-tools"
import {
  configuredForkProviderKinds,
  deriveForkClonePlan,
  deriveForkCloneUrl,
  forkEventTags,
  parseRepoReference,
  repoIdentityFromAnnouncement,
  releaseRepoContext,
  resolveRepoRelayPolicy,
} from "../src/repo.js"
import type {AppCfg, ProviderCfg, RepoIdentity, RepoRegistry} from "../src/types.js"

const pubkey = getPublicKey(new Uint8Array(Buffer.from("2222222222222222222222222222222222222222222222222222222222222222", "hex")))
const npub = nip19.npubEncode(pubkey)
const ownerPubkey = getPublicKey(new Uint8Array(Buffer.from("3333333333333333333333333333333333333333333333333333333333333333", "hex")))
const ownerNpub = nip19.npubEncode(ownerPubkey)

const app = (
  nostrGit: Partial<AppCfg["config"]["nostr_git"]> = {},
  providers: Record<string, ProviderCfg> = {},
  reporting: Partial<AppCfg["config"]["reporting"]> = {},
): AppCfg => ({
  root: "/tmp/openteam",
  config: {
    runtimeRoot: "/tmp/openteam/runtime",
    opencode: {binary: "opencode", model: "", agent: "build"},
    browser: {headless: true, mcp: {name: "playwright", command: [], environment: {}}},
    providers,
    repos: {},
    reporting: {
      dmRelays: [],
      outboxRelays: [],
      relayListBootstrapRelays: [],
      appDataRelays: [],
      signerRelays: [],
      allowFrom: [],
      reportTo: [],
      ...reporting,
    },
    nostr_git: {
      graspServers: [],
      gitDataRelays: [],
      repoAnnouncementRelays: [],
      forkGitOwner: "",
      forkRepoPrefix: "",
      forkCloneUrlTemplate: "",
      ...nostrGit,
    },
    agents: {},
  },
})

const identity = {
  key: `30617:${pubkey}:flotilla-budabit`,
  ownerPubkey: pubkey,
  ownerNpub: npub,
  identifier: "flotilla-budabit",
  announcementEventId: "event-id",
  announcedAt: 123,
  relays: [],
  cloneUrls: [],
  rawTags: [],
} satisfies RepoIdentity

describe("repo references", () => {
  test("parses nostr git URI with relay hints", () => {
    const ref = parseRepoReference(`nostr://${npub}/relay.ngit.dev/flotilla-budabit?relay=relay.damus.io`)

    expect(ref).toEqual({
      ownerPubkey: pubkey,
      identifier: "flotilla-budabit",
      relays: ["wss://relay.ngit.dev", "wss://relay.damus.io"],
    })
  })

  test("parses nostr naddr URI", () => {
    const naddr = nip19.naddrEncode({
      kind: 30617,
      pubkey,
      identifier: "flotilla-budabit",
      relays: ["wss://nos.lol"],
    })

    expect(parseRepoReference(`nostr://${naddr}`)).toEqual({
      ownerPubkey: pubkey,
      identifier: "flotilla-budabit",
      relays: ["wss://nos.lol"],
    })
  })
})

describe("repo announcements", () => {
  test("preserves ordered clone URLs and reads ngit relays tag", () => {
    const identity = repoIdentityFromAnnouncement({
      id: "event-id",
      pubkey,
      created_at: 123,
      content: "",
      tags: [
        ["d", "flotilla-budabit"],
        ["clone", "https://primary.example/repos/flotilla-budabit.git", "https://fallback.example/repos/flotilla-budabit.git"],
        ["relays", "wss://relay-one.example", "wss://relay-two.example"],
        ["r", "0123456789012345678901234567890123456789", "euc"],
      ],
    })

    expect(identity?.cloneUrls).toEqual([
      "https://primary.example/repos/flotilla-budabit.git",
      "https://fallback.example/repos/flotilla-budabit.git",
    ])
    expect(identity?.relays).toEqual(["wss://relay-one.example", "wss://relay-two.example"])
  })
})

describe("repo relay policy", () => {
  test("uses only tagged repo relays for GRASP-backed repositories", () => {
    const graspIdentity = {
      ...identity,
      relays: ["wss://relay.ngit.dev"],
      cloneUrls: [`https://relay.ngit.dev/${npub}/flotilla-budabit.git`],
      rawTags: [
        ["d", "flotilla-budabit"],
        ["clone", `https://relay.ngit.dev/${npub}/flotilla-budabit.git`],
        ["relays", "wss://relay.ngit.dev"],
      ],
    }

    expect(resolveRepoRelayPolicy(
      app(
        {repoAnnouncementRelays: ["wss://fallback.example"], gitDataRelays: ["wss://git.example"]},
        {},
        {outboxRelays: ["wss://outbox.example"], appDataRelays: ["wss://app.example"]},
      ),
      graspIdentity,
    )).toEqual({
      repoRelays: ["wss://relay.ngit.dev"],
      publishRelays: ["wss://relay.ngit.dev"],
      naddrRelays: ["wss://relay.ngit.dev"],
      taggedRelays: ["wss://relay.ngit.dev"],
      isGrasp: true,
    })
  })

  test("uses tagged plus fallback repo relays, outbox, and git relays for non-GRASP repositories", () => {
    const naddr = nip19.naddrEncode({
      kind: 30617,
      pubkey,
      identifier: "flotilla-budabit",
      relays: ["wss://hint.example"],
    })
    const nonGraspIdentity = {
      ...identity,
      sourceHint: naddr,
      relays: ["wss://repo-relay.example"],
      cloneUrls: ["https://github.com/upstream/flotilla-budabit.git"],
      rawTags: [
        ["d", "flotilla-budabit"],
        ["clone", "https://github.com/upstream/flotilla-budabit.git"],
        ["relays", "wss://repo-relay.example"],
      ],
    }

    expect(resolveRepoRelayPolicy(
      app(
        {
          graspServers: ["wss://relay.ngit.dev"],
          gitDataRelays: ["wss://git.example"],
          repoAnnouncementRelays: ["wss://fallback.example"],
        },
        {},
        {
          outboxRelays: ["wss://outbox.example"],
          appDataRelays: ["wss://app.example"],
          relayListBootstrapRelays: ["wss://bootstrap.example"],
        },
      ),
      nonGraspIdentity,
    )).toEqual({
      repoRelays: [
        "wss://repo-relay.example",
        "wss://hint.example",
        "wss://fallback.example",
      ],
      publishRelays: [
        "wss://repo-relay.example",
        "wss://hint.example",
        "wss://fallback.example",
        "wss://outbox.example",
        "wss://git.example",
      ],
      naddrRelays: [
        "wss://repo-relay.example",
        "wss://hint.example",
        "wss://fallback.example",
        "wss://outbox.example",
        "wss://git.example",
      ],
      taggedRelays: ["wss://repo-relay.example"],
      isGrasp: false,
    })
  })
})

describe("repo context leases", () => {
  test("releases a context only when the expected lease matches", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-runtime-"))
    const testApp = app()
    testApp.config.runtimeRoot = runtimeRoot
    const registryFile = path.join(runtimeRoot, "repos", "registry.json")
    const registry: RepoRegistry = {
      version: 1,
      repos: {},
      forks: {},
      contexts: {
        ctx1: {
          id: "ctx1",
          repoKey: identity.key,
          path: "/tmp/context",
          checkout: "/tmp/context/checkout",
          mirror: "/tmp/mirror",
          mode: "code",
          baseRef: "HEAD",
          baseCommit: "abc123",
          branch: "openteam/test",
          state: "leased",
          lease: {
            workerId: "builder-01",
            role: "builder",
            jobId: "task-a",
            mode: "code",
            leasedAt: "2026-04-25T00:00:00.000Z",
          },
          createdAt: "2026-04-25T00:00:00.000Z",
          updatedAt: "2026-04-25T00:00:00.000Z",
        },
      },
    }

    await mkdir(path.dirname(registryFile), {recursive: true})
    await writeFile(registryFile, `${JSON.stringify(registry, null, 2)}\n`)

    expect(await releaseRepoContext(testApp, "ctx1", {workerId: "builder-02", jobId: "task-a"})).toBe(false)
    const stillLeased = JSON.parse(await readFile(registryFile, "utf8")) as RepoRegistry
    expect(stillLeased.contexts.ctx1?.state).toBe("leased")
    expect(stillLeased.contexts.ctx1?.lease?.workerId).toBe("builder-01")

    expect(await releaseRepoContext(testApp, "ctx1", {workerId: "builder-01", jobId: "task-a"})).toBe(true)
    const released = JSON.parse(await readFile(registryFile, "utf8")) as RepoRegistry
    expect(released.contexts.ctx1?.state).toBe("idle")
    expect(released.contexts.ctx1?.lease).toBeUndefined()
  })
})

describe("fork clone URLs", () => {
  test("derives ngit-style orchestrator fork clone URL from owner npub path segment", () => {
    expect(deriveForkCloneUrl(
      app(),
      identity,
      `https://relay.ngit.dev/${npub}/flotilla-budabit.git`,
      {npub: ownerNpub, pubkey: ownerPubkey},
    )).toBe(`https://relay.ngit.dev/${ownerNpub}/flotilla-budabit.git`)
  })

  test("uses repo announcement identifier for fork URL leaf, not an identity with .git", () => {
    expect(deriveForkCloneUrl(
      app({forkRepoPrefix: "openteam-"}),
      identity,
      `https://relay.ngit.dev/${npub}/some-provider-path.git`,
      {npub: ownerNpub, pubkey: ownerPubkey},
    )).toBe(`https://relay.ngit.dev/${ownerNpub}/openteam-flotilla-budabit.git`)
  })

  test("uses configured GRASP servers as the orchestrator fork namespace", () => {
    expect(deriveForkClonePlan(
      app({graspServers: ["wss://grasp.budabit.club", "wss://relay.ngit.dev"]}),
      identity,
      "https://git.example.com/repos/flotilla-budabit.git",
      {npub: ownerNpub, pubkey: ownerPubkey},
    )).toEqual({
      cloneUrls: [
        `https://grasp.budabit.club/${ownerNpub}/flotilla-budabit.git`,
        `https://relay.ngit.dev/${ownerNpub}/flotilla-budabit.git`,
      ],
      publishBeforePush: true,
    })
  })

  test("prioritizes GitHub, then GitLab, then GRASP targets", () => {
    expect(configuredForkProviderKinds(app(
      {graspServers: ["wss://relay.ngit.dev"]},
      {
        gitlab: {type: "gitlab", host: "gitlab.com", token: "gitlab-token"},
        github: {type: "github", host: "github.com", token: "github-token"},
      },
    ))).toEqual(["github", "gitlab"])
  })

  test("adds only actual GRASP storage relays to GRASP fork announcements", () => {
    const tags = forkEventTags(
      app({graspServers: ["wss://relay.ngit.dev"], repoAnnouncementRelays: ["wss://nos.lol"]}),
      identity,
      [`https://relay.ngit.dev/${ownerNpub}/flotilla-budabit.git`],
      `https://github.com/upstream/flotilla-budabit.git`,
    )

    expect(tags.find(tag => tag[0] === "relays")).toEqual(["relays", "wss://relay.ngit.dev"])
  })

  test("does not add configured GRASP relays to non-GRASP fork announcements", () => {
    const tags = forkEventTags(
      app({graspServers: ["wss://relay.ngit.dev"], repoAnnouncementRelays: ["wss://nos.lol"]}),
      identity,
      ["https://github.com/openteam/flotilla-budabit.git"],
      `https://github.com/upstream/flotilla-budabit.git`,
    )

    expect(tags.find(tag => tag[0] === "relays")).toEqual(["relays", "wss://nos.lol"])
  })
})
