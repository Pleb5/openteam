import {describe, expect, test} from "bun:test"
import {mkdir, mkdtemp, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {pullRequestTargetBranch} from "../src/commands/repo-publish.js"
import {
  buildCommentEvent,
  buildPullRequestEvent,
  buildPullRequestUpdateEvent,
  buildRoleLabelEvent,
  buildStatusEvent,
  KIND_GIT_COMMENT,
  KIND_GIT_LABEL,
  KIND_GIT_PULL_REQUEST,
  KIND_GIT_PULL_REQUEST_UPDATE,
  KIND_GIT_STATUS_APPLIED,
  loadRepoPublishContext,
  pullRequestCloneUrlsForTarget,
  repoMaintainerPubkeys,
  upstreamPullRequestNeedsClone,
} from "../src/repo-publish.js"

const repoAddr = "30617:owner-pubkey:repo"

const hasTag = (tags: string[][], expected: string[]) =>
  tags.some(tag => JSON.stringify(tag) === JSON.stringify(expected))

const validIdentity = {
  key: repoAddr,
  ownerPubkey: "owner-pubkey",
  ownerNpub: "npub1owner",
  identifier: "repo",
  announcementEventId: "event-id",
  announcedAt: 1,
  relays: ["wss://repo.example.com"],
  cloneUrls: ["https://example.com/repo.git"],
  rawTags: [],
}

const validPolicy = {
  repoRelays: ["wss://repo.example.com"],
  publishRelays: ["wss://repo.example.com"],
  naddrRelays: ["wss://repo.example.com"],
  taggedRelays: ["wss://repo.example.com"],
  isGrasp: false,
}

const writeContext = async (patch: Record<string, unknown> = {}) => {
  const root = await mkdtemp(path.join(tmpdir(), "openteam-repo-context-"))
  const checkout = path.join(root, "checkout")
  await mkdir(checkout, {recursive: true})
  const file = path.join(root, "repo-context.json")
  await writeFile(file, `${JSON.stringify({
    version: 1,
    agentId: "builder-01",
    target: "nostr://npub1owner/repo",
    checkout,
    defaultScope: "repo",
    repo: validIdentity,
    policy: validPolicy,
    ...patch,
  }, null, 2)}\n`)
  return {file, checkout}
}

describe("repo publish event builders", () => {
  test("builds NIP-22 comments with repo context and root tags", () => {
    const event = buildCommentEvent({
      repoAddr,
      content: "Reproduced in browser.",
      rootId: "issue-id",
      rootKind: 1621,
      rootPubkey: "issue-author",
      parentId: "parent-comment",
      parentKind: 1111,
    })

    expect(event.kind).toBe(KIND_GIT_COMMENT)
    expect(event.content).toBe("Reproduced in browser.")
    expect(hasTag(event.tags ?? [], ["E", "issue-id"])).toBe(true)
    expect(hasTag(event.tags ?? [], ["K", "1621"])).toBe(true)
    expect(hasTag(event.tags ?? [], ["P", "issue-author"])).toBe(true)
    expect(hasTag(event.tags ?? [], ["e", "parent-comment"])).toBe(true)
    expect(hasTag(event.tags ?? [], ["k", "1111"])).toBe(true)
    expect(hasTag(event.tags ?? [], ["repo", repoAddr])).toBe(true)
  })

  test("builds role label events using the Nostr-git role namespace", () => {
    const event = buildRoleLabelEvent({
      repoAddr,
      rootId: "issue-id",
      role: "assignee",
      pubkeys: ["worker-pubkey"],
    })

    expect(event.kind).toBe(KIND_GIT_LABEL)
    expect(hasTag(event.tags ?? [], ["L", "org.nostr.git.role"])).toBe(true)
    expect(hasTag(event.tags ?? [], ["l", "assignee", "org.nostr.git.role"])).toBe(true)
    expect(hasTag(event.tags ?? [], ["e", "issue-id"])).toBe(true)
    expect(hasTag(event.tags ?? [], ["a", repoAddr])).toBe(true)
    expect(hasTag(event.tags ?? [], ["p", "worker-pubkey"])).toBe(true)
  })

  test("builds applied status events with merge metadata", () => {
    const event = buildStatusEvent({
      repoAddr,
      state: "applied",
      rootId: "pr-id",
      content: "Merged as abc123.",
      mergeCommit: "abc123",
      appliedCommits: ["def456"],
    })

    expect(event.kind).toBe(KIND_GIT_STATUS_APPLIED)
    expect(hasTag(event.tags ?? [], ["e", "pr-id", "", "root"])).toBe(true)
    expect(hasTag(event.tags ?? [], ["a", repoAddr])).toBe(true)
    expect(hasTag(event.tags ?? [], ["merge-commit", "abc123"])).toBe(true)
    expect(hasTag(event.tags ?? [], ["applied-as-commits", "def456"])).toBe(true)
    expect(hasTag(event.tags ?? [], ["r", "abc123"])).toBe(true)
    expect(hasTag(event.tags ?? [], ["r", "def456"])).toBe(true)
  })

  test("builds PR and PR update events with clone and commit tags", () => {
    const pr = buildPullRequestEvent({
      repoAddr,
      subject: "Fix login flow",
      tipCommitOid: "tip123",
      clone: ["https://example.com/openteam/repo.git"],
      targetBranch: "main",
      mergeBase: "base123",
      labels: ["bug"],
      recipients: ["maintainer"],
    })
    const update = buildPullRequestUpdateEvent({
      repoAddr,
      pullRequestEventId: "pr-id",
      pullRequestAuthorPubkey: "pr-author",
      tipCommitOid: "tip456",
      clone: ["https://example.com/openteam/repo.git"],
      mergeBase: "base456",
    })

    expect(pr.kind).toBe(KIND_GIT_PULL_REQUEST)
    expect(hasTag(pr.tags ?? [], ["a", repoAddr])).toBe(true)
    expect(hasTag(pr.tags ?? [], ["subject", "Fix login flow"])).toBe(true)
    expect(hasTag(pr.tags ?? [], ["c", "tip123"])).toBe(true)
    expect(hasTag(pr.tags ?? [], ["clone", "https://example.com/openteam/repo.git"])).toBe(true)
    expect(hasTag(pr.tags ?? [], ["branch-name", "main"])).toBe(true)
    expect(hasTag(pr.tags ?? [], ["merge-base", "base123"])).toBe(true)
    expect(hasTag(pr.tags ?? [], ["t", "bug"])).toBe(true)
    expect(hasTag(pr.tags ?? [], ["p", "maintainer"])).toBe(true)

    expect(update.kind).toBe(KIND_GIT_PULL_REQUEST_UPDATE)
    expect(hasTag(update.tags ?? [], ["E", "pr-id"])).toBe(true)
    expect(hasTag(update.tags ?? [], ["P", "pr-author"])).toBe(true)
    expect(hasTag(update.tags ?? [], ["c", "tip456"])).toBe(true)
    expect(hasTag(update.tags ?? [], ["merge-base", "base456"])).toBe(true)
  })

  test("infers Nostr-git PR source clone URLs from upstream fork context", () => {
    const upstream = {
      ...validIdentity,
      key: "30617:upstream-owner:repo",
      ownerPubkey: "upstream-owner",
      cloneUrls: ["https://example.com/upstream/repo.git"],
    }
    const fork = {
      ...validIdentity,
      key: "30617:fork-owner:repo",
      ownerPubkey: "fork-owner",
      cloneUrls: ["https://example.com/openteam/repo.git"],
    }
    const target = {
      scope: "upstream" as const,
      identity: upstream,
      context: {
        version: 1 as const,
        agentId: "builder-01",
        target: "nostr://npub1upstream/repo",
        defaultScope: "upstream" as const,
        repo: fork,
        upstreamRepo: upstream,
        policy: validPolicy,
        upstreamPolicy: validPolicy,
      },
    }

    expect(upstreamPullRequestNeedsClone(target)).toBe(true)
    expect(pullRequestCloneUrlsForTarget(target)).toEqual(["https://example.com/openteam/repo.git"])
    expect(pullRequestCloneUrlsForTarget(target, ["https://override.example.com/repo.git"])).toEqual(["https://override.example.com/repo.git"])

    const pr = buildPullRequestEvent({
      repoAddr: target.identity.key,
      subject: "Fix upstream bug",
      tipCommitOid: "tip789",
      clone: pullRequestCloneUrlsForTarget(target),
      targetBranch: "main",
    })

    expect(hasTag(pr.tags ?? [], ["a", "30617:upstream-owner:repo"])).toBe(true)
    expect(hasTag(pr.tags ?? [], ["clone", "https://example.com/openteam/repo.git"])).toBe(true)
  })

  test("infers repo owner and maintainers as PR recipients", () => {
    const owner = "0".repeat(64)
    const maintainer = "1".repeat(64)
    const ignored = "not-a-pubkey"

    expect(repoMaintainerPubkeys({
      ownerPubkey: owner,
      rawTags: [
        ["maintainers", maintainer, ignored],
        ["maintainer", maintainer],
      ],
    })).toEqual([owner, maintainer])
  })

  test("rejects ambiguous legacy PR branch argument", () => {
    expect(() => pullRequestTargetBranch(["--branch", "fix/source-branch"])).toThrow("--branch is ambiguous")
    expect(pullRequestTargetBranch(["--target-branch", "main"])).toBe("main")
  })

  test("rejects repo publish contexts with a missing checkout", async () => {
    const {file} = await writeContext({checkout: path.join(tmpdir(), `openteam-missing-checkout-${Date.now()}`)})

    await expect(loadRepoPublishContext(file)).rejects.toThrow("checkout does not exist")
  })

  test("rejects repo publish contexts with an invalid default scope", async () => {
    const {file} = await writeContext({defaultScope: "fork"})

    await expect(loadRepoPublishContext(file)).rejects.toThrow("invalid defaultScope")
  })

  test("rejects upstream default scope without upstream repo identity", async () => {
    const {file} = await writeContext({defaultScope: "upstream"})

    await expect(loadRepoPublishContext(file)).rejects.toThrow("missing upstreamRepo")
  })
})
