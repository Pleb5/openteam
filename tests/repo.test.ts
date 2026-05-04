import {describe, expect, test} from "bun:test"
import {mkdtemp, mkdir, readFile, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {getPublicKey, nip19} from "nostr-tools"
import {
  configuredForkProviderKinds,
  deriveForkClonePlan,
  deriveForkCloneUrl,
  ensureGithubForkRepo,
  ensureGitlabForkRepo,
  forkEventTags,
  activeLatestRepoAnnouncementEvents,
  parseRepoReference,
  pushForkTargets,
  repoIdentityFromAnnouncement,
  releaseRepoContext,
  resolveRepoRelayPolicy,
  selectOwnerRepoAnnouncementByCloneUrl,
  type ProviderApiFetch,
  type RepoAnnouncementEvent,
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

type ApiCall = {
  url: string
  init: RequestInit
}

const response = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => typeof body === "string" ? body : JSON.stringify(body),
})

const sequenceFetch = (items: Array<{status: number; body: unknown}>) => {
  const calls: ApiCall[] = []
  const fetch: ProviderApiFetch = async (url, init) => {
    calls.push({url, init})
    const item = items.shift()
    if (!item) throw new Error(`unexpected API call: ${url}`)
    return response(item.status, item.body)
  }
  return {fetch, calls}
}

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

  test("deleted repo announcements suppress older announcements for the same d tag", () => {
    const oldActive: RepoAnnouncementEvent = {
      id: "old-event",
      pubkey,
      created_at: 10,
      content: "",
      tags: [["d", "nostr-git-fork"], ["clone", "https://github.com/Pleb5/nostr-git-fork.git"]],
    }
    const deleted: RepoAnnouncementEvent = {
      id: "deleted-event",
      pubkey,
      created_at: 20,
      content: "",
      tags: [["d", "nostr-git-fork"], ["clone", "https://github.com/Pleb5/nostr-git-fork.git"], ["deleted", "true"]],
    }

    expect(repoIdentityFromAnnouncement(deleted)).toBeUndefined()
    expect(activeLatestRepoAnnouncementEvents([oldActive, deleted])).toEqual([])
  })

  test("selects latest active owner announcement matching a submodule clone URL", () => {
    const cloneUrl = "https://github.com/Pleb5/nostr-git-fork.git"
    const events: RepoAnnouncementEvent[] = [
      {
        id: "old-fork",
        pubkey,
        created_at: 10,
        content: "",
        tags: [["d", "nostr-git-fork"], ["clone", cloneUrl]],
      },
      {
        id: "deleted-fork",
        pubkey,
        created_at: 30,
        content: "",
        tags: [["d", "nostr-git-fork"], ["clone", cloneUrl], ["deleted", "true"]],
      },
      {
        id: "renamed-active",
        pubkey,
        created_at: 20,
        content: "",
        tags: [["d", "nostr-git"], ["clone", cloneUrl], ["clone", "https://github.com/chebizarro/nostr-git.git"]],
      },
    ]

    const selected = selectOwnerRepoAnnouncementByCloneUrl(events, pubkey, `${cloneUrl}/`)

    expect(selected.identity?.key).toBe(`30617:${pubkey}:nostr-git`)
    expect(selected.deletedMatches.map(match => match.key)).toEqual([`30617:${pubkey}:nostr-git-fork`])
  })

  test("reports only deleted owner announcements matching a submodule clone URL", () => {
    const cloneUrl = "https://github.com/Pleb5/nostr-git-fork.git"
    const selected = selectOwnerRepoAnnouncementByCloneUrl([
      {
        id: "old-fork",
        pubkey,
        created_at: 10,
        content: "",
        tags: [["d", "nostr-git-fork"], ["clone", cloneUrl]],
      },
      {
        id: "deleted-fork",
        pubkey,
        created_at: 30,
        content: "",
        tags: [["d", "nostr-git-fork"], ["clone", cloneUrl], ["deleted", "true"]],
      },
    ], pubkey, cloneUrl)

    expect(selected.identity).toBeUndefined()
    expect(selected.deletedMatches.map(match => match.key)).toEqual([`30617:${pubkey}:nostr-git-fork`])
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

describe("provider fork contracts", () => {
  test("creates GitHub fork storage repositories through the configured namespace", async () => {
    const {fetch, calls} = sequenceFetch([
      {status: 200, body: {login: "octobot"}},
      {status: 201, body: {clone_url: "https://github.com/budabit-agent-gh/openteam-repo.git"}},
    ])

    const result = await ensureGithubForkRepo({
      type: "github",
      host: "github.com",
      token: "gh-token",
      namespace: "budabit-agent-gh",
      username: "openteam-bot",
      private: true,
    }, "openteam-repo", "openteam fork", {fetch})

    expect(result).toEqual({
      cloneUrl: "https://github.com/budabit-agent-gh/openteam-repo.git",
      username: "openteam-bot",
    })
    expect(calls.map(call => `${call.init.method} ${call.url}`)).toEqual([
      "GET https://api.github.com/user",
      "POST https://api.github.com/orgs/budabit-agent-gh/repos",
    ])
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      name: "openteam-repo",
      description: "openteam fork",
      private: true,
      auto_init: false,
    })
    expect((calls[1]?.init.headers as Record<string, string>).authorization).toBe("Bearer gh-token")
  })

  test("reuses existing GitHub fork storage repositories after create conflicts", async () => {
    const {fetch, calls} = sequenceFetch([
      {status: 200, body: {login: "octobot"}},
      {status: 422, body: {message: "name already exists on this account"}},
      {status: 200, body: {clone_url: "https://github.com/octobot/openteam-repo.git"}},
    ])

    const result = await ensureGithubForkRepo({
      type: "github",
      host: "github.com",
      token: "gh-token",
    }, "openteam-repo", "openteam fork", {fetch})

    expect(result).toEqual({
      cloneUrl: "https://github.com/octobot/openteam-repo.git",
      username: "octobot",
    })
    expect(calls.map(call => `${call.init.method} ${call.url}`)).toEqual([
      "GET https://api.github.com/user",
      "POST https://api.github.com/user/repos",
      "GET https://api.github.com/repos/octobot/openteam-repo",
    ])
  })

  test("surfaces GitHub auth failures with API status and message", async () => {
    const {fetch} = sequenceFetch([
      {status: 401, body: {message: "Bad credentials"}},
    ])

    await expect(ensureGithubForkRepo({
      type: "github",
      host: "github.com",
      token: "bad-token",
    }, "openteam-repo", "openteam fork", {fetch})).rejects.toThrow("GitHub user lookup failed (401: Bad credentials)")
  })

  test("creates GitLab fork storage projects with namespace and visibility settings", async () => {
    const {fetch, calls} = sequenceFetch([
      {status: 200, body: {id: 7, username: "gitlab-bot"}},
      {status: 201, body: {http_url_to_repo: "https://gitlab.com/team/openteam-repo.git"}},
    ])

    const result = await ensureGitlabForkRepo({
      type: "gitlab",
      host: "gitlab.com",
      token: "gl-token",
      namespaceId: 42,
      visibility: "internal",
    }, "openteam-repo", "openteam fork", {fetch})

    expect(result).toEqual({
      cloneUrl: "https://gitlab.com/team/openteam-repo.git",
      username: "gitlab-bot",
    })
    expect(calls.map(call => `${call.init.method} ${call.url}`)).toEqual([
      "GET https://gitlab.com/api/v4/user",
      "POST https://gitlab.com/api/v4/projects",
    ])
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      name: "openteam-repo",
      path: "openteam-repo",
      description: "openteam fork",
      visibility: "internal",
      namespace_id: 42,
    })
    expect((calls[1]?.init.headers as Record<string, string>)["private-token"]).toBe("gl-token")
  })

  test("reuses existing GitLab fork storage projects after create conflicts", async () => {
    const {fetch, calls} = sequenceFetch([
      {status: 200, body: {id: 7, username: "gitlab-bot"}},
      {status: 409, body: {message: "has already been taken"}},
      {status: 200, body: {http_url_to_repo: "https://gitlab.com/team/openteam-repo.git"}},
    ])

    const result = await ensureGitlabForkRepo({
      type: "gitlab",
      host: "gitlab.com",
      token: "gl-token",
      namespacePath: "team",
    }, "openteam-repo", "openteam fork", {fetch})

    expect(result).toEqual({
      cloneUrl: "https://gitlab.com/team/openteam-repo.git",
      username: "gitlab-bot",
    })
    expect(calls.map(call => `${call.init.method} ${call.url}`)).toEqual([
      "GET https://gitlab.com/api/v4/user",
      "POST https://gitlab.com/api/v4/projects",
      "GET https://gitlab.com/api/v4/projects/team%2Fopenteam-repo",
    ])
  })

  test("ignores configured fork providers that do not have a token", () => {
    expect(configuredForkProviderKinds(app(
      {},
      {
        github: {type: "github", host: "github.com", token: ""},
        gitlab: {type: "gitlab", host: "gitlab.com", token: "gl-token"},
      },
    ))).toEqual(["gitlab"])
  })

  test("GRASP fork plans publish announcements before push", () => {
    expect(deriveForkClonePlan(
      app({graspServers: ["wss://grasp.example.com"]}),
      identity,
      "https://git.example.com/upstream/flotilla-budabit.git",
      {npub: ownerNpub, pubkey: ownerPubkey},
    )).toEqual({
      cloneUrls: [`https://grasp.example.com/${ownerNpub}/flotilla-budabit.git`],
      publishBeforePush: true,
    })
  })

  test("aggregates all fork push failures before reporting a provisioning blocker", () => {
    expect(() => pushForkTargets([
      "https://fork-one.example/repo.git",
      "https://fork-two.example/repo.git",
    ], "https://upstream.example/repo.git", forkUrl => {
      throw new Error(`push rejected for ${forkUrl}`)
    })).toThrow("failed to populate orchestrator fork")
    expect(() => pushForkTargets([
      "https://fork-one.example/repo.git",
      "https://fork-two.example/repo.git",
    ], "https://upstream.example/repo.git", forkUrl => {
      throw new Error(`push rejected for ${forkUrl}`)
    })).toThrow("https://fork-one.example/repo.git: Error: push rejected for https://fork-one.example/repo.git")
    expect(() => pushForkTargets([
      "https://fork-one.example/repo.git",
      "https://fork-two.example/repo.git",
    ], "https://upstream.example/repo.git", forkUrl => {
      throw new Error(`push rejected for ${forkUrl}`)
    })).toThrow("https://fork-two.example/repo.git: Error: push rejected for https://fork-two.example/repo.git")
  })
})
