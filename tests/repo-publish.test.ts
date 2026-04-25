import {describe, expect, test} from "bun:test"
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
} from "../src/repo-publish.js"

const repoAddr = "30617:owner-pubkey:repo"

const hasTag = (tags: string[][], expected: string[]) =>
  tags.some(tag => JSON.stringify(tag) === JSON.stringify(expected))

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
      branchName: "main",
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
})
