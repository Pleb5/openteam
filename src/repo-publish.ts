import {existsSync} from "node:fs"
import {mkdir, readFile, writeFile} from "node:fs/promises"
import path from "node:path"
import {prepareAgent} from "./config.js"
import {
  KIND_GIT_COMMENT,
  KIND_GIT_ISSUE,
  KIND_GIT_LABEL,
  KIND_GIT_PULL_REQUEST,
  KIND_GIT_PULL_REQUEST_UPDATE,
  KIND_GIT_STATUS_APPLIED,
  KIND_GIT_STATUS_CLOSED,
  KIND_GIT_STATUS_DRAFT,
  KIND_GIT_STATUS_OPEN,
  REPO_EVENT_KINDS,
  TAG_NAMESPACE_GIT_ROLE,
} from "./events.js"
import {publishEventDetailed, secretKey, type PublishSummary} from "./nostr.js"
import {
  resolveRepoAnnouncementTarget,
  resolveRepoRelayPolicy,
  type RepoRelayPolicy,
} from "./repo.js"
import type {AppCfg, PreparedAgent, RepoIdentity, ResolvedRepoTarget} from "./types.js"

export {
  KIND_GIT_COMMENT,
  KIND_GIT_ISSUE,
  KIND_GIT_LABEL,
  KIND_GIT_PULL_REQUEST,
  KIND_GIT_PULL_REQUEST_UPDATE,
  KIND_GIT_STATUS_APPLIED,
  KIND_GIT_STATUS_CLOSED,
  KIND_GIT_STATUS_DRAFT,
  KIND_GIT_STATUS_OPEN,
}

const CONTEXT_VERSION = 1

type UnsignedRepoEvent = {
  kind: number
  content?: string
  tags?: string[][]
  created_at?: number
}

type PreparedRepoEvent = {
  kind: number
  content: string
  tags: string[][]
  created_at: number
}

export type RepoPublishContext = {
  version: 1
  agentId: string
  target: string
  contextId?: string
  checkout?: string
  defaultScope?: RepoPublishScope
  repo: RepoIdentity
  upstreamRepo?: RepoIdentity
  policy: RepoRelayPolicy
  upstreamPolicy?: RepoRelayPolicy
}

export type RepoPublishScope = "repo" | "upstream"

export type ResolvedRepoPublishTarget = {
  agent: PreparedAgent
  context?: RepoPublishContext
  identity: RepoIdentity
  policy: RepoRelayPolicy
  target: string
  scope: RepoPublishScope
}

export type RepoPublishResult = {
  dryRun: boolean
  scope: RepoPublishScope
  repo: string
  relays: string[]
  event: UnsignedRepoEvent
  publish?: PublishSummary
}

type ResolveOptions = {
  agentId?: string
  target?: string
  context?: string
  scope?: RepoPublishScope
  cwd?: string
}

type PublishOptions = ResolveOptions & {
  dryRun?: boolean
}

export type ExtraTags = string[][]

export type BuildIssueInput = {
  repoAddr: string
  subject: string
  content?: string
  labels?: string[]
  recipients?: string[]
  tags?: ExtraTags
}

export type BuildCommentInput = {
  repoAddr: string
  content: string
  rootId: string
  rootKind: string | number
  rootPubkey?: string
  rootRelay?: string
  parentId?: string
  parentKind?: string | number
  parentPubkey?: string
  parentRelay?: string
  tags?: ExtraTags
}

export type BuildLabelInput = {
  repoAddr: string
  targetId?: string
  labels: string[]
  namespace?: string
  delete?: boolean
  pubkeys?: string[]
  tags?: ExtraTags
  content?: string
}

export type BuildRoleLabelInput = {
  repoAddr: string
  rootId: string
  role: "assignee" | "reviewer" | string
  pubkeys: string[]
  namespace?: string
  content?: string
}

export type BuildStatusInput = {
  repoAddr: string
  state: "open" | "applied" | "closed" | "draft" | number
  rootId: string
  content?: string
  replyId?: string
  recipients?: string[]
  mergeCommit?: string
  appliedCommits?: string[]
  tags?: ExtraTags
}

export type BuildPullRequestInput = {
  repoAddr: string
  subject?: string
  content?: string
  labels?: string[]
  recipients?: string[]
  tipCommitOid: string
  clone?: string[]
  branchName?: string
  mergeBase?: string
  tags?: ExtraTags
}

export type BuildPullRequestUpdateInput = {
  repoAddr: string
  pullRequestEventId: string
  pullRequestAuthorPubkey: string
  recipients?: string[]
  tipCommitOid: string
  clone?: string[]
  mergeBase?: string
  tags?: ExtraTags
}

const nowSec = () => Math.floor(Date.now() / 1000)

const uniq = (items: string[]) => Array.from(new Set(items.filter(Boolean)))

const repoContextFile = (checkout: string) => path.join(checkout, ".openteam", "repo-context.json")

const repoAddress = (identity: RepoIdentity) => identity.key

export const repoPublishContextPath = repoContextFile

export const writeRepoPublishContext = async (
  app: AppCfg,
  agent: PreparedAgent,
  resolved: ResolvedRepoTarget,
  policy: RepoRelayPolicy,
  defaultScope: RepoPublishScope = "repo",
) => {
  const file = repoContextFile(resolved.context.checkout)
  const upstreamPolicy = resolved.upstreamIdentity
    ? resolveRepoRelayPolicy(app, resolved.upstreamIdentity, {target: resolved.target})
    : undefined
  const context: RepoPublishContext = {
    version: CONTEXT_VERSION,
    agentId: agent.id,
    target: resolved.target,
    contextId: resolved.context.id,
    checkout: resolved.context.checkout,
    defaultScope,
    repo: resolved.identity,
    upstreamRepo: resolved.upstreamIdentity,
    policy,
    upstreamPolicy,
  }

  await mkdir(path.dirname(file), {recursive: true})
  await writeFile(file, `${JSON.stringify(context, null, 2)}\n`)
  return file
}

const findContextFile = (cwd: string) => {
  const explicit = process.env.OPENTEAM_REPO_CONTEXT || process.env.OPENTEAM_REPO_CONTEXT_FILE
  if (explicit) return explicit

  let current = path.resolve(cwd)
  for (;;) {
    const candidate = path.join(current, ".openteam", "repo-context.json")
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(current)
    if (parent === current) return ""
    current = parent
  }
}

export const loadRepoPublishContext = async (file?: string, cwd = process.cwd()) => {
  const resolved = file || findContextFile(cwd)
  if (!resolved || !existsSync(resolved)) return undefined
  const context = JSON.parse(await readFile(resolved, "utf8")) as RepoPublishContext
  if (context.version !== CONTEXT_VERSION) {
    throw new Error(`unsupported repo publish context version in ${resolved}`)
  }
  return context
}

export const resolveRepoPublishTarget = async (
  app: AppCfg,
  options: ResolveOptions = {},
): Promise<ResolvedRepoPublishTarget> => {
  const context = await loadRepoPublishContext(options.context, options.cwd)
  const requestedScope = options.scope ?? context?.defaultScope ?? "repo"

  if (context) {
    const agent = await prepareAgent(app, options.agentId || context.agentId)
    const effectiveScope = requestedScope === "upstream" && context.upstreamRepo ? "upstream" : "repo"
    const identity = effectiveScope === "upstream" && context.upstreamRepo ? context.upstreamRepo : context.repo
    const target = context.target
    const policy = resolveRepoRelayPolicy(app, identity, {target})
    return {agent, context, identity, policy, target, scope: effectiveScope}
  }

  if (!options.agentId || !options.target) {
    throw new Error("repo publish helper requires an active .openteam/repo-context.json or both --agent and --target")
  }

  const agent = await prepareAgent(app, options.agentId)
  const resolved = await resolveRepoAnnouncementTarget(app, agent, options.target)
  const policy = resolveRepoRelayPolicy(app, resolved.identity, {target: options.target})
  return {
    agent,
    identity: resolved.identity,
    policy,
    target: options.target,
    scope: requestedScope,
  }
}

const normalizeEvent = (event: UnsignedRepoEvent): PreparedRepoEvent => ({
  kind: Number(event.kind),
  created_at: event.created_at ?? nowSec(),
  content: event.content ?? "",
  tags: Array.isArray(event.tags) ? event.tags : [],
})

const hasTag = (tags: string[][], name: string, value?: string) =>
  tags.some(tag => tag[0] === name && (value === undefined || tag[1] === value))

const appendRepoScope = (event: UnsignedRepoEvent, identity: RepoIdentity): PreparedRepoEvent => {
  const normalized = normalizeEvent(event)
  const repoAddr = repoAddress(identity)
  const tags = [...(normalized.tags ?? [])]

  if (
    [
      KIND_GIT_ISSUE,
      KIND_GIT_PULL_REQUEST,
      KIND_GIT_PULL_REQUEST_UPDATE,
      KIND_GIT_LABEL,
      KIND_GIT_STATUS_OPEN,
      KIND_GIT_STATUS_APPLIED,
      KIND_GIT_STATUS_CLOSED,
      KIND_GIT_STATUS_DRAFT,
    ].includes(normalized.kind) &&
    !hasTag(tags, "a", repoAddr)
  ) {
    tags.push(["a", repoAddr])
  }

  if (normalized.kind === KIND_GIT_COMMENT && !hasTag(tags, "repo", repoAddr)) {
    tags.push(["repo", repoAddr])
  }

  return {...normalized, tags}
}

const allowedRepoEventKinds = new Set<number>(REPO_EVENT_KINDS)

export const publishRepoEvent = async (
  app: AppCfg,
  event: UnsignedRepoEvent,
  options: PublishOptions = {},
): Promise<RepoPublishResult> => {
  const target = await resolveRepoPublishTarget(app, options)
  const prepared = appendRepoScope(event, target.identity)

  if (!allowedRepoEventKinds.has(prepared.kind)) {
    throw new Error(`kind ${prepared.kind} is not a supported repo-side publish helper event kind`)
  }

  if (target.policy.publishRelays.length === 0) {
    throw new Error(`repo ${target.identity.key} has no publish relays from the resolved relay policy`)
  }

  if (options.dryRun) {
    return {
      dryRun: true,
      scope: target.scope,
      repo: target.identity.key,
      relays: target.policy.publishRelays,
      event: prepared,
    }
  }

  const publish = await publishEventDetailed(target.policy.publishRelays, prepared, secretKey(target.agent))
  return {
    dryRun: false,
    scope: target.scope,
    repo: target.identity.key,
    relays: target.policy.publishRelays,
    event: prepared,
    publish,
  }
}

export const buildIssueEvent = ({
  repoAddr,
  subject,
  content = "",
  labels = [],
  recipients = [],
  tags = [],
}: BuildIssueInput): UnsignedRepoEvent => ({
  kind: KIND_GIT_ISSUE,
  content,
  created_at: nowSec(),
  tags: [
    ["a", repoAddr],
    ["subject", subject],
    ...labels.map(label => ["t", label]),
    ...recipients.map(pubkey => ["p", pubkey]),
    ...tags,
  ],
})

export const buildCommentEvent = ({
  repoAddr,
  content,
  rootId,
  rootKind,
  rootPubkey,
  rootRelay,
  parentId,
  parentKind,
  parentPubkey,
  parentRelay,
  tags = [],
}: BuildCommentInput): UnsignedRepoEvent => {
  const builtTags: string[][] = [
    ["E", rootId],
    ["K", String(rootKind)],
    ["repo", repoAddr],
  ]
  if (rootPubkey) builtTags.push(["P", rootPubkey])
  if (rootRelay) builtTags.push(["R", rootRelay])
  if (parentId) builtTags.push(["e", parentId])
  if (parentKind) builtTags.push(["k", String(parentKind)])
  if (parentPubkey) builtTags.push(["p", parentPubkey])
  if (parentRelay) builtTags.push(["r", parentRelay])

  return {
    kind: KIND_GIT_COMMENT,
    content,
    created_at: nowSec(),
    tags: [...builtTags, ...tags],
  }
}

export const buildLabelEvent = ({
  repoAddr,
  targetId,
  labels,
  namespace,
  delete: shouldDelete = false,
  pubkeys = [],
  tags = [],
  content = "",
}: BuildLabelInput): UnsignedRepoEvent => ({
  kind: KIND_GIT_LABEL,
  content,
  created_at: nowSec(),
  tags: [
    ...(namespace ? [["L", namespace]] : []),
    ...labels.map(label => {
      if (namespace && shouldDelete) return ["l", label, namespace, "del"]
      if (namespace) return ["l", label, namespace]
      return ["l", label]
    }),
    ...(targetId ? [["e", targetId]] : []),
    ["a", repoAddr],
    ...pubkeys.map(pubkey => ["p", pubkey]),
    ...tags,
  ],
})

export const buildRoleLabelEvent = ({
  repoAddr,
  rootId,
  role,
  pubkeys,
  namespace = TAG_NAMESPACE_GIT_ROLE,
  content = "",
}: BuildRoleLabelInput): UnsignedRepoEvent =>
  buildLabelEvent({
    repoAddr,
    targetId: rootId,
    labels: [role],
    namespace,
    pubkeys,
    content,
  })

const statusKind = (state: BuildStatusInput["state"]) => {
  if (typeof state === "number") return state
  if (state === "open") return KIND_GIT_STATUS_OPEN
  if (state === "applied") return KIND_GIT_STATUS_APPLIED
  if (state === "closed") return KIND_GIT_STATUS_CLOSED
  if (state === "draft") return KIND_GIT_STATUS_DRAFT
  throw new Error(`unknown status state: ${state}`)
}

export const buildStatusEvent = ({
  repoAddr,
  state,
  rootId,
  content = "",
  replyId,
  recipients = [],
  mergeCommit,
  appliedCommits = [],
  tags = [],
}: BuildStatusInput): UnsignedRepoEvent => ({
  kind: statusKind(state),
  content,
  created_at: nowSec(),
  tags: [
    ["e", rootId, "", "root"],
    ...(replyId ? [["e", replyId, "", "reply"]] : []),
    ...recipients.map(pubkey => ["p", pubkey]),
    ["a", repoAddr],
    ...(mergeCommit ? [["merge-commit", mergeCommit], ["r", mergeCommit]] : []),
    ...(appliedCommits.length > 0 ? [["applied-as-commits", ...appliedCommits]] : []),
    ...appliedCommits.map(commit => ["r", commit]),
    ...tags,
  ],
})

export const buildPullRequestEvent = ({
  repoAddr,
  subject,
  content = "",
  labels = [],
  recipients = [],
  tipCommitOid,
  clone = [],
  branchName,
  mergeBase,
  tags = [],
}: BuildPullRequestInput): UnsignedRepoEvent => ({
  kind: KIND_GIT_PULL_REQUEST,
  content,
  created_at: nowSec(),
  tags: [
    ["a", repoAddr],
    ...recipients.map(pubkey => ["p", pubkey]),
    ...(subject ? [["subject", subject]] : []),
    ...labels.map(label => ["t", label]),
    ["c", tipCommitOid],
    ...(clone.length > 0 ? [["clone", ...clone]] : []),
    ...(branchName ? [["branch-name", branchName]] : []),
    ...(mergeBase ? [["merge-base", mergeBase]] : []),
    ...tags,
  ],
})

export const buildPullRequestUpdateEvent = ({
  repoAddr,
  pullRequestEventId,
  pullRequestAuthorPubkey,
  recipients = [],
  tipCommitOid,
  clone = [],
  mergeBase,
  tags = [],
}: BuildPullRequestUpdateInput): UnsignedRepoEvent => ({
  kind: KIND_GIT_PULL_REQUEST_UPDATE,
  content: "",
  created_at: nowSec(),
  tags: [
    ["a", repoAddr],
    ["E", pullRequestEventId],
    ["P", pullRequestAuthorPubkey],
    ...recipients.map(pubkey => ["p", pubkey]),
    ["c", tipCommitOid],
    ...(clone.length > 0 ? [["clone", ...clone]] : []),
    ...(mergeBase ? [["merge-base", mergeBase]] : []),
    ...tags,
  ],
})

export const repoAddrForPublishTarget = (target: ResolvedRepoPublishTarget) => repoAddress(target.identity)

export const publishPolicySummary = (target: ResolvedRepoPublishTarget) => ({
  scope: target.scope,
  repo: target.identity.key,
  relays: {
    repo: target.policy.repoRelays,
    publish: target.policy.publishRelays,
    naddr: target.policy.naddrRelays,
    tagged: target.policy.taggedRelays,
  },
  isGrasp: target.policy.isGrasp,
})

export const parseRawRepoEvent = (value: string): UnsignedRepoEvent => {
  const parsed = JSON.parse(value) as UnsignedRepoEvent
  if (!parsed || typeof parsed !== "object" || typeof parsed.kind !== "number") {
    throw new Error("raw repo event JSON must include numeric kind")
  }
  return parsed
}
