import {existsSync} from "node:fs"
import {spawnSync} from "node:child_process"
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
import {configureCheckoutGitAuth, gitAuthEnv} from "./git-auth.js"
import {publishEventDetailed, secretKey, type PublishSummary} from "./nostr.js"
import {
  ensureOrchestratorForkForRepo,
  resolveRepoAnnouncementTarget,
  resolveOwnerRepoAnnouncementByCloneUrl,
  resolveRepoRelayPolicy,
  readGitSubmodules,
  type RepoRelayPolicy,
  type GitSubmodule,
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
  sourceCloneUrls?: string[]
  sourceCheckout?: string
  sourceBranch?: string
  sourceAuthUsername?: string
  managedSource?: boolean
  submodule?: {
    path: string
    url: string
  }
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
  preferSubmodule?: boolean
  dryRun?: boolean
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
  targetBranch?: string
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

const isPubkey = (value: string) => /^[0-9a-f]{64}$/i.test(value)

const repoContextFile = (checkout: string) => path.join(checkout, ".openteam", "repo-context.json")

const repoAddress = (identity: RepoIdentity) => identity.key

const slashPath = (value: string) => path.normalize(value).replace(/\\/g, "/")

const isInsideCheckout = (checkout: string, value: string) => {
  const relative = path.relative(path.resolve(checkout), path.resolve(value))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

const submoduleContainsPath = (submodule: GitSubmodule, relativePath: string) => {
  const modulePath = slashPath(submodule.path)
  const relative = slashPath(relativePath)
  return relative === modulePath || relative.startsWith(`${modulePath}/`)
}

const submoduleForPublishPath = async (checkout: string, cwd: string) => {
  const submodules = await readGitSubmodules(checkout)
  if (submodules.length === 0) return undefined

  const candidates: string[] = []
  if (isInsideCheckout(checkout, cwd)) {
    const relative = slashPath(path.relative(path.resolve(checkout), path.resolve(cwd)))
    if (relative && relative !== ".") candidates.push(relative)
  }
  const subjectPath = process.env.OPENTEAM_SUBJECT_PATH?.trim()
  if (subjectPath) candidates.push(slashPath(subjectPath))

  for (const candidate of candidates) {
    const matches = submodules
      .filter(submodule => submoduleContainsPath(submodule, candidate))
      .sort((a, b) => b.path.length - a.path.length)
    if (matches[0]) return matches[0]
  }
}

const runGit = (cwd: string, args: string[], env?: Record<string, string | undefined>) => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: env ? {...process.env, ...env} : process.env,
  })
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`)
  }
  return result.stdout.trim()
}

const ensureRemote = (checkout: string, name: string, url: string) => {
  if (runGit(checkout, ["remote"], undefined).split(/\r?\n/).includes(name)) {
    runGit(checkout, ["remote", "set-url", name, url])
    return
  }
  runGit(checkout, ["remote", "add", name, url])
}

const configureManagedSourceRemote = async (
  app: AppCfg,
  checkout: string,
  sourceUrl: string,
  upstreamUrl: string,
  authUsername?: string,
) => {
  ensureRemote(checkout, "origin", sourceUrl)
  if (upstreamUrl && upstreamUrl !== sourceUrl) ensureRemote(checkout, "upstream", upstreamUrl)

  const auth = await configureCheckoutGitAuth(app, checkout, [sourceUrl], authUsername)
  if (!auth) return
  runGit(checkout, ["config", "--local", "--replace-all", "credential.helper", ""])
  runGit(checkout, ["config", "--local", "--add", "credential.helper", auth.helperCommand])
  runGit(checkout, ["config", "--local", "--replace-all", "credential.useHttpPath", "true"])
}

const currentBranch = (checkout: string) => {
  const result = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {cwd: checkout, encoding: "utf8"})
  return result.status === 0 ? result.stdout.trim() : ""
}

const safeSourceBranch = (checkout: string, tip: string) =>
  currentBranch(checkout) || `openteam/pr-${tip.slice(0, 12)}`

const normalizeCloneUrl = (value: string) => value.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase()

const sameCloneSet = (left: string[], right: string[]) => {
  const a = left.map(normalizeCloneUrl).sort()
  const b = right.map(normalizeCloneUrl).sort()
  return a.length === b.length && a.every((value, index) => value === b[index])
}

const hasLocalCommit = (checkout: string, tip: string) => {
  const result = spawnSync("git", ["cat-file", "-e", `${tip}^{commit}`], {cwd: checkout, encoding: "utf8"})
  return result.status === 0
}

const remoteContainsTip = (app: AppCfg, checkout: string, cloneUrl: string, tip: string, authUsername?: string) => {
  const result = spawnSync("git", ["ls-remote", cloneUrl], {
    cwd: checkout,
    encoding: "utf8",
    env: {...process.env, ...(gitAuthEnv(app, cloneUrl, authUsername) ?? {})},
  })
  if (result.status !== 0) return false
  return result.stdout.split(/\r?\n/).some(line => line.split(/\s+/)[0] === tip)
}

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

const isPublishScope = (value: unknown): value is RepoPublishScope =>
  value === "repo" || value === "upstream"

const assertRepoIdentityReady = (identity: RepoIdentity | undefined, file: string, label: string) => {
  if (!identity) {
    throw new Error(`repo publish context ${file} is missing ${label}`)
  }
  if (!identity.key?.trim()) {
    throw new Error(`repo publish context ${file} is missing ${label}.key`)
  }
  if (!identity.ownerPubkey?.trim()) {
    throw new Error(`repo publish context ${file} is missing ${label}.ownerPubkey`)
  }
  if (!identity.identifier?.trim()) {
    throw new Error(`repo publish context ${file} is missing ${label}.identifier`)
  }
}

export const assertRepoPublishContextReady = (context: RepoPublishContext, file: string) => {
  if (context.version !== CONTEXT_VERSION) {
    throw new Error(`unsupported repo publish context version in ${file}`)
  }
  if (!context.agentId?.trim()) {
    throw new Error(`repo publish context ${file} is missing agentId`)
  }
  if (!context.target?.trim()) {
    throw new Error(`repo publish context ${file} is missing target`)
  }
  if (!context.checkout?.trim()) {
    throw new Error(`repo publish context ${file} is missing checkout`)
  }
  if (!existsSync(context.checkout)) {
    throw new Error(`repo publish context ${file} checkout does not exist: ${context.checkout}`)
  }
  if (context.defaultScope !== undefined && !isPublishScope(context.defaultScope)) {
    throw new Error(`repo publish context ${file} has invalid defaultScope: ${String(context.defaultScope)}`)
  }
  assertRepoIdentityReady(context.repo, file, "repo")
  if (context.defaultScope === "upstream") {
    assertRepoIdentityReady(context.upstreamRepo, file, "upstreamRepo")
  }
  if (context.upstreamRepo) {
    assertRepoIdentityReady(context.upstreamRepo, file, "upstreamRepo")
  }
}

export const loadRepoPublishContext = async (file?: string, cwd = process.cwd()) => {
  const resolved = file || findContextFile(cwd)
  if (!resolved || !existsSync(resolved)) return undefined
  const context = JSON.parse(await readFile(resolved, "utf8")) as RepoPublishContext
  assertRepoPublishContextReady(context, resolved)
  return context
}

const resolveSubmodulePublishTarget = async (
  app: AppCfg,
  agent: PreparedAgent,
  context: RepoPublishContext,
  cwd: string,
  dryRun = false,
): Promise<ResolvedRepoPublishTarget | undefined> => {
  if (!context.checkout) return undefined
  const submodule = await submoduleForPublishPath(context.checkout, cwd)
  if (!submodule) return undefined
  if (!submodule.url) {
    throw new Error(`submodule ${submodule.path} has no url in .gitmodules; refusing to publish PR without an owner-announced submodule repo`)
  }

  const owner = context.upstreamRepo ?? context.repo
  const identity = await resolveOwnerRepoAnnouncementByCloneUrl(app, owner, submodule.url, context.target)
  const submoduleCheckout = path.join(context.checkout, submodule.path)
  const policy = resolveRepoRelayPolicy(app, identity, {target: identity.key})
  if (dryRun) {
    return {
      agent,
      context,
      identity,
      policy,
      target: identity.key,
      scope: "repo",
      sourceCheckout: submoduleCheckout,
      managedSource: true,
      submodule: {
        path: submodule.path,
        url: submodule.url,
      },
    }
  }
  const fork = await ensureOrchestratorForkForRepo(app, identity, submodule.url)
  const sourceCloneUrls = uniq([
    ...(fork.fork?.forkCloneUrls ?? []),
    ...(fork.fork?.forkCloneUrl ? [fork.fork.forkCloneUrl] : []),
    ...fork.identity.cloneUrls,
    fork.source,
  ])
  if (sourceCloneUrls.length === 0) {
    throw new Error(`openteam could not resolve a source fork clone URL for submodule repo ${identity.key}`)
  }
  await configureManagedSourceRemote(app, submoduleCheckout, sourceCloneUrls[0], submodule.url, fork.authUsername)
  return {
    agent,
    context,
    identity,
    policy,
    target: identity.key,
    scope: "repo",
    sourceCloneUrls,
    sourceCheckout: submoduleCheckout,
    sourceBranch: currentBranch(submoduleCheckout) || undefined,
    sourceAuthUsername: fork.authUsername,
    managedSource: true,
    submodule: {
      path: submodule.path,
      url: submodule.url,
    },
  }
}

export const resolveRepoPublishTarget = async (
  app: AppCfg,
  options: ResolveOptions = {},
): Promise<ResolvedRepoPublishTarget> => {
  const context = await loadRepoPublishContext(options.context, options.cwd)
  const requestedScope = options.scope ?? context?.defaultScope ?? "repo"

  if (context) {
    const agent = await prepareAgent(app, options.agentId || context.agentId)
    if (options.preferSubmodule) {
      const submoduleTarget = await resolveSubmodulePublishTarget(app, agent, context, options.cwd ?? process.cwd(), options.dryRun)
      if (submoduleTarget) return submoduleTarget
    }
    if (options.target) {
      const resolved = await resolveRepoAnnouncementTarget(app, agent, options.target)
      const explicitScope = options.scope ?? (context.upstreamRepo?.key === resolved.identity.key ? "upstream" : "repo")
      const policy = resolveRepoRelayPolicy(app, resolved.identity, {target: options.target})
      return {agent, context, identity: resolved.identity, policy, target: options.target, scope: explicitScope}
    }
    if (!isPublishScope(requestedScope)) {
      throw new Error(`invalid repo publish scope: ${String(requestedScope)}`)
    }
    if (requestedScope === "upstream" && !context.upstreamRepo) {
      throw new Error(`repo publish scope upstream requested but context has no upstream repo: ${options.context ?? context.checkout}`)
    }
    const effectiveScope = requestedScope
    const identity = effectiveScope === "upstream" ? context.upstreamRepo! : context.repo
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
  targetBranch,
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
    ...(targetBranch ? [["branch-name", targetBranch]] : []),
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

export const repoMaintainerPubkeys = (identity: Pick<RepoIdentity, "ownerPubkey" | "rawTags">) => uniq([
  identity.ownerPubkey,
  ...identity.rawTags
    .filter(tag => tag[0] === "maintainers" || tag[0] === "maintainer")
    .flatMap(tag => tag.slice(1)),
]).filter(isPubkey)

export const pullRequestCloneUrlsForTarget = (
  target: Pick<ResolvedRepoPublishTarget, "scope" | "identity" | "context" | "sourceCloneUrls">,
  explicit: string[] = [],
) => {
  if (target.sourceCloneUrls && target.sourceCloneUrls.length > 0) {
    const managed = uniq(target.sourceCloneUrls)
    if (explicit.length > 0 && !sameCloneSet(explicit, managed)) {
      throw new Error("submodule PR source clone URLs are managed by openteam; do not override them with --clone")
    }
    return managed
  }
  if (explicit.length > 0) return uniq(explicit)
  if (target.scope !== "upstream") return []
  const source = target.context?.repo
  if (!source || source.key === target.identity.key) return []
  return uniq(source.cloneUrls)
}

export const preparePullRequestSourceCloneUrls = async (
  app: AppCfg,
  target: Pick<ResolvedRepoPublishTarget, "scope" | "identity" | "context" | "sourceCloneUrls" | "sourceCheckout" | "sourceBranch" | "sourceAuthUsername" | "managedSource">,
  explicit: string[],
  tipCommitOid: string,
  options: {dryRun?: boolean} = {},
) => {
  const cloneUrls = pullRequestCloneUrlsForTarget(target, explicit)
  if (options.dryRun) return cloneUrls
  if (cloneUrls.length === 0) return []

  if (target.managedSource) {
    if (!target.sourceCheckout) {
      throw new Error("managed PR source is missing a local checkout; refusing to publish unverifiable clone URLs")
    }
    if (!hasLocalCommit(target.sourceCheckout, tipCommitOid)) {
      throw new Error(`PR tip ${tipCommitOid} is not present in the managed source checkout`)
    }
    const branch = target.sourceBranch || safeSourceBranch(target.sourceCheckout, tipCommitOid)
    const pushed: string[] = []
    const failures: string[] = []
    for (const cloneUrl of cloneUrls) {
      try {
        runGit(target.sourceCheckout, ["push", cloneUrl, `${tipCommitOid}:refs/heads/${branch}`], gitAuthEnv(app, cloneUrl, target.sourceAuthUsername))
        if (!remoteContainsTip(app, target.sourceCheckout, cloneUrl, tipCommitOid, target.sourceAuthUsername)) {
          throw new Error("remote did not advertise pushed tip")
        }
        pushed.push(cloneUrl)
      } catch (error) {
        failures.push(`${cloneUrl}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (pushed.length === 0) {
      throw new Error([
        `PR tip ${tipCommitOid} was not pushed to any openteam-managed source clone`,
        ...failures,
      ].join("\n"))
    }
    if (failures.length > 0) {
      process.stderr.write(`some managed PR source pushes failed:\n${failures.join("\n")}\n`)
    }
    return pushed
  }

  const verified = cloneUrls.filter(cloneUrl => remoteContainsTip(app, process.cwd(), cloneUrl, tipCommitOid))
  if (verified.length === 0) {
    throw new Error(`PR tip ${tipCommitOid} was not advertised by any PR source clone URL; push the branch to an openteam-controlled fork before publishing`)
  }
  if (verified.length !== cloneUrls.length) {
    const missing = cloneUrls.filter(cloneUrl => !verified.includes(cloneUrl))
    process.stderr.write(`dropping PR clone URLs that do not advertise ${tipCommitOid}:\n${missing.join("\n")}\n`)
  }
  return verified
}

export const upstreamPullRequestNeedsClone = (
  target: Pick<ResolvedRepoPublishTarget, "scope" | "identity" | "context">,
) => target.scope === "upstream" && Boolean(target.context?.repo && target.context.repo.key !== target.identity.key)

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
