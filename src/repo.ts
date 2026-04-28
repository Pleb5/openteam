import {existsSync} from "node:fs"
import {mkdir, readFile, rename, rm, stat, writeFile} from "node:fs/promises"
import {spawnSync} from "node:child_process"
import path from "node:path"
import {nip19} from "nostr-tools"
import {prepareAgent} from "./config.js"
import {KIND_OUTBOX_RELAYS, KIND_REPO_ANNOUNCEMENT} from "./events.js"
import {configureCheckoutGitAuth, gitAuthEnv} from "./git-auth.js"
import {decodeNpub, encodeNpub, getSelfNpub, getSelfPubkey, publishEventDetailed, queryEvents, secretKey} from "./nostr.js"
import type {
  AppCfg,
  PreparedAgent,
  ProviderCfg,
  RepoCfg,
  RepoContext,
  RepoFork,
  RepoIdentity,
  RepoRegistry,
  ResolvedRepoTarget,
  TaskItem,
  TaskMode,
  WorkerLease,
} from "./types.js"

const DEFAULT_REPO_DISCOVERY_RELAYS = ["wss://nos.lol", "wss://relay.damus.io", "wss://purplepag.es"]

type RepoAnnouncementEvent = {
  id: string
  pubkey: string
  created_at: number
  tags: string[][]
  content: string
}

type TargetProfile = {
  profile: RepoCfg
  hint: string
  label: string
}

type DirectRepoRef = {
  ownerPubkey: string
  identifier: string
  relays: string[]
}

const now = () => new Date().toISOString()

const uniq = (items: string[]) => Array.from(new Set(items.filter(Boolean)))

const safe = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "repo"

const isUrl = (value: string) => /^(https?:\/\/|ssh:\/\/|[^:\s]+@[^:\s]+:)/.test(value)

const isRelayLikeUrl = (value: string) => {
  try {
    const url = new URL(value)
    return ["ws:", "wss:", "http:", "https:"].includes(url.protocol)
  } catch {
    return false
  }
}

const normalizeRelay = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return ""
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `wss://${trimmed}`
  return withScheme.replace(/\/+$/, "")
}

const relayValues = (tags: string[][], names: string[]) =>
  uniq(tagTailValues(tags, names).map(normalizeRelay).filter(isRelayLikeUrl))

const normalizeUrl = (value: string) => value.trim().replace(/\/+$/, "").replace(/\.git$/, "")

const comparable = (value: string) => normalizeUrl(value).toLowerCase()

const tagValues = (tags: string[][], names: string[]) =>
  tags
    .filter(tag => names.includes(tag[0]) && tag[1])
    .map(tag => tag[1])

const tagTailValues = (tags: string[][], names: string[]) =>
  tags
    .filter(tag => names.includes(tag[0]))
    .flatMap(tag => tag.slice(1).filter(Boolean))

const firstTag = (tags: string[][], names: string[]) => tagValues(tags, names)[0]

const registryFile = (app: AppCfg) => path.join(app.config.runtimeRoot, "repos", "registry.json")
const registryLockDir = (app: AppCfg) => path.join(app.config.runtimeRoot, "repos", ".registry.lock")

const ensureDir = async (dir: string) => {
  await mkdir(dir, {recursive: true})
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const withRepoRegistryLock = async <T>(app: AppCfg, fn: () => Promise<T>) => {
  const lockDir = registryLockDir(app)
  await ensureDir(path.dirname(lockDir))
  const started = Date.now()

  for (;;) {
    try {
      await mkdir(lockDir)
      break
    } catch {
      try {
        const info = await stat(lockDir)
        if (Date.now() - info.mtimeMs > 10 * 60_000) {
          await rm(lockDir, {recursive: true, force: true})
          continue
        }
      } catch {}

      if (Date.now() - started > 120_000) {
        throw new Error("timed out waiting for repo registry lock")
      }
      await sleep(150)
    }
  }

  try {
    return await fn()
  } finally {
    await rm(lockDir, {recursive: true, force: true})
  }
}

export const loadRepoRegistry = async (app: AppCfg): Promise<RepoRegistry> => {
  const file = registryFile(app)
  if (!existsSync(file)) {
    return {version: 1, repos: {}, contexts: {}, forks: {}}
  }
  const registry = JSON.parse(await readFile(file, "utf8")) as Partial<RepoRegistry>
  return {
    version: 1,
    repos: registry.repos ?? {},
    contexts: registry.contexts ?? {},
    forks: registry.forks ?? {},
  }
}

const saveRepoRegistry = async (app: AppCfg, registry: RepoRegistry) => {
  const file = registryFile(app)
  await ensureDir(path.dirname(file))
  await writeFile(file, `${JSON.stringify(registry, null, 2)}\n`)
}

const repoKey = (ownerPubkey: string, identifier: string) => `${KIND_REPO_ANNOUNCEMENT}:${ownerPubkey}:${identifier}`

const runGit = (args: string[], cwd: string, env?: Record<string, string | undefined>) => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: env ? {...process.env, ...env} : process.env,
  })
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `git ${args.join(" ")} exited with code ${result.status ?? -1}`)
  }
  return result.stdout.trim()
}

const tryGit = (args: string[], cwd: string) => {
  const result = spawnSync("git", args, {cwd, encoding: "utf8"})
  return result.status === 0 ? result.stdout.trim() : ""
}

const targetProfile = (app: AppCfg, agent: PreparedAgent, target?: string): TargetProfile => {
  const raw = target?.trim()
  if (raw && app.config.repos[raw]) {
    const profile = app.config.repos[raw]
    return {profile, hint: profile.root, label: raw}
  }

  if (raw) {
    return {profile: agent.repo, hint: raw, label: raw}
  }

  return {profile: agent.repo, hint: agent.repo.root, label: agent.agent.repo}
}

const normalizeRelays = (items: string[]) =>
  uniq(items.map(normalizeRelay).filter(isRelayLikeUrl))

export const repoAnnouncementRelays = (app: AppCfg) =>
  normalizeRelays(app.config.nostr_git.repoAnnouncementRelays ?? [])

export const repoDiscoveryRelays = (app: AppCfg) =>
  uniq([
    ...repoAnnouncementRelays(app),
    ...app.config.nostr_git.gitDataRelays,
    ...app.config.nostr_git.graspServers.map(graspRelayUrl),
    ...app.config.reporting.appDataRelays,
    ...app.config.reporting.outboxRelays,
    ...app.config.reporting.relayListBootstrapRelays,
  ].map(normalizeRelay).filter(isRelayLikeUrl))

const decodeSegment = (value: string) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const queryRelayHints = (query: string) => {
  const params = new URLSearchParams(query)
  const relays: string[] = []
  for (const [key, value] of params.entries()) {
    if (/^relay\d*$/i.test(key)) relays.push(value)
  }
  return uniq(relays.map(normalizeRelay).filter(isRelayLikeUrl))
}

const parseNaddr = (value: string): DirectRepoRef | undefined => {
  const decoded = nip19.decode(value)
  if (decoded.type !== "naddr") return
  const data = decoded.data as {kind?: number; pubkey: string; identifier: string; relays?: string[]}
  if (data.kind !== KIND_REPO_ANNOUNCEMENT) return
  return {
    ownerPubkey: data.pubkey,
    identifier: data.identifier,
    relays: uniq((data.relays ?? []).map(normalizeRelay).filter(isRelayLikeUrl)),
  }
}

const parseNostrUri = (value: string): DirectRepoRef | undefined => {
  if (!value.toLowerCase().startsWith("nostr://")) return

  const withoutScheme = value.slice("nostr://".length)
  const [withoutFragment] = withoutScheme.split("#", 1)
  const queryStart = withoutFragment.indexOf("?")
  const body = queryStart === -1 ? withoutFragment : withoutFragment.slice(0, queryStart)
  const query = queryStart === -1 ? "" : withoutFragment.slice(queryStart + 1)
  const queryRelays = queryRelayHints(query)
  const segments = body.split("/").filter(Boolean).map(decodeSegment)

  if (segments.length === 0) return

  if (segments[0].startsWith("naddr1")) {
    const naddr = parseNaddr(segments[0])
    return naddr ? {...naddr, relays: uniq([...naddr.relays, ...queryRelays])} : undefined
  }

  const ownerIndex = segments.findIndex(segment => /^npub1[0-9a-z]+$/i.test(segment))
  if (ownerIndex === -1 || ownerIndex === segments.length - 1) return

  const identifier = segments[segments.length - 1]
  const relayHints = segments.slice(ownerIndex + 1, -1).map(normalizeRelay).filter(isRelayLikeUrl)

  return {
    ownerPubkey: decodeNpub(segments[ownerIndex]),
    identifier,
    relays: uniq([...relayHints, ...queryRelays]),
  }
}

const parseDirectRepoRef = (value: string): DirectRepoRef | undefined => {
  const nostrUri = parseNostrUri(value)
  if (nostrUri) return nostrUri

  if (value.startsWith("naddr1")) {
    return parseNaddr(value)
  }

  const canonical = value.match(new RegExp(`^${KIND_REPO_ANNOUNCEMENT}:([^:]+):(.+)$`))
  if (canonical) {
    const owner = canonical[1].startsWith("npub1") ? decodeNpub(canonical[1]) : canonical[1]
    return {
      ownerPubkey: owner,
      identifier: canonical[2],
      relays: [],
    }
  }

  const npubPath = value.match(/^(npub1[0-9a-z]+)\/(.+)$/i)
  if (npubPath) {
    return {
      ownerPubkey: decodeNpub(npubPath[1]),
      identifier: npubPath[2],
      relays: [],
    }
  }
}

export const parseRepoReference = (value: string) => parseDirectRepoRef(value)

const cloneUrlsFrom = (event: RepoAnnouncementEvent) => {
  const fromTags = tagTailValues(event.tags, ["clone", "git", "url", "repo", "source"])
    .filter(value => isUrl(value) || existsSync(value))

  const fromContent = event.content
    .split(/\s+/)
    .filter(value => isUrl(value))

  return uniq([...fromTags, ...fromContent])
}

const identityFromEvent = (event: RepoAnnouncementEvent, sourceHint?: string): RepoIdentity | undefined => {
  const identifier = firstTag(event.tags, ["d"])
  if (!identifier) return

  const relays = relayValues(event.tags, ["relays", "relay"])
  const name = firstTag(event.tags, ["name", "title", "alt"])
  const defaultBranch = firstTag(event.tags, ["HEAD", "head", "default_branch", "default-branch", "branch"])
  const ownerNpub = encodeNpub(event.pubkey)

  return {
    key: repoKey(event.pubkey, identifier),
    ownerPubkey: event.pubkey,
    ownerNpub,
    identifier,
    announcementEventId: event.id,
    announcedAt: event.created_at,
    relays,
    cloneUrls: cloneUrlsFrom(event),
    name,
    defaultBranch,
    sourceHint,
    rawTags: event.tags,
  }
}

export const repoIdentityFromAnnouncement = (event: RepoAnnouncementEvent, sourceHint?: string) =>
  identityFromEvent(event, sourceHint)

const localHintValues = (hint: string) => {
  const values = [hint]
  const local = path.isAbsolute(hint) ? hint : path.resolve(process.env.OPENTEAM_CALLER_CWD || process.cwd(), hint)
  if (existsSync(local)) {
    values.push(local)
    const remote = tryGit(["config", "--get", "remote.origin.url"], local)
    if (remote) values.push(remote)
    values.push(path.basename(local.replace(/\.git$/, "")))
  }
  if (isUrl(hint)) {
    values.push(path.basename(hint.replace(/\.git$/, "")))
  }
  return uniq(values)
}

const matchesHint = (identity: RepoIdentity, event: RepoAnnouncementEvent, hint: string) => {
  const hints = localHintValues(hint).map(comparable)
  const candidates = uniq([
    identity.key,
    `${identity.ownerNpub}/${identity.identifier}`,
    identity.identifier,
    identity.name ?? "",
    identity.sourceHint ?? "",
    ...identity.cloneUrls,
    ...event.tags.flatMap(tag => tag.slice(1)),
  ]).map(comparable)

  return hints.some(hintValue => candidates.some(candidate => candidate === hintValue || candidate.endsWith(`/${hintValue}`)))
}

const latest = (events: RepoAnnouncementEvent[]) =>
  [...events].sort((a, b) => b.created_at - a.created_at)[0]

const nowSec = () => Math.floor(Date.now() / 1000)

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const hasCommit = (root: string, commit: string) =>
  Boolean(tryGit(["cat-file", "-e", `${commit}^{commit}`], root))

const orchestratorOwner = async (app: AppCfg) => {
  const orchestrator = await prepareAgent(app, "orchestrator-01")
  return {
    pubkey: getSelfPubkey(orchestrator),
    npub: getSelfNpub(orchestrator),
    signer: orchestrator,
  }
}

const forkIdentifier = (app: AppCfg, upstream: RepoIdentity) =>
  `${app.config.nostr_git.forkRepoPrefix || ""}${upstream.identifier}`

const smartHttpUrl = (value: string) => /^https?:\/\//i.test(value)

const providerHost = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return ""

  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    return url.host.toLowerCase()
  } catch {
    return trimmed.toLowerCase()
  }
}

type ForkStorageProvider = {
  key: string
  kind: "github" | "gitlab"
  config: ProviderCfg
}

type ForkTargetPlan = ForkClonePlan & {
  provider: RepoFork["provider"]
  authUsername?: string
}

type ApiError = Error & {status?: number}
type FetchResponseLike = Pick<Response, "ok" | "status" | "text">
export type ProviderApiFetch = (url: string, init: RequestInit) => Promise<FetchResponseLike>
type ProviderApiOptions = {
  fetch?: ProviderApiFetch
}

const providerType = (key: string, provider: ProviderCfg): ForkStorageProvider["kind"] | undefined => {
  if (provider.type === "github" || provider.type === "gitlab") return provider.type
  if (provider.type === "generic") return

  const host = providerHost(provider.host || key)
  if (host === "github.com") return "github"
  if (host === "gitlab.com" || host.includes("gitlab")) return "gitlab"
}

const configuredForkProviders = (app: AppCfg): ForkStorageProvider[] =>
  (Object.entries(app.config.providers) as Array<[string, ProviderCfg]>)
    .map(([key, config]) => {
      const kind = providerType(key, config)
      return kind ? {key, kind, config} : undefined
    })
    .filter((item): item is ForkStorageProvider => Boolean(item?.config.token))
    .sort((a, b) => (a.kind === "github" ? 0 : 1) - (b.kind === "github" ? 0 : 1))

export const configuredForkProviderKinds = (app: AppCfg) =>
  configuredForkProviders(app).map(provider => provider.kind)

const apiBodyMessage = (body: unknown) => {
  if (!body) return ""
  if (typeof body === "string") return body.slice(0, 500)
  if (typeof body === "object" && body !== null) {
    const message = (body as {message?: unknown}).message
    if (typeof message === "string") return message
  }
  return JSON.stringify(body).slice(0, 500)
}

const requestJson = async <T>(url: string, init: RequestInit, label: string, fetcher?: ProviderApiFetch): Promise<T> => {
  const response = await (fetcher ?? fetch)(url, init)
  const text = await response.text()
  let body: unknown = text
  if (text) {
    try {
      body = JSON.parse(text) as unknown
    } catch {}
  }

  if (!response.ok) {
    const message = apiBodyMessage(body)
    const error = new Error(`${label} failed (${response.status}${message ? `: ${message}` : ""})`) as ApiError
    error.status = response.status
    throw error
  }

  return body as T
}

const githubApiBase = (provider: ProviderCfg) => {
  if (provider.apiBaseUrl) return provider.apiBaseUrl.replace(/\/+$/, "")
  const host = providerHost(provider.host)
  return host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`
}

const githubHeaders = (provider: ProviderCfg) => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${provider.token}`,
  "content-type": "application/json",
  "user-agent": "openteam",
})

const githubCurrentUser = async (provider: ProviderCfg, options: ProviderApiOptions = {}) =>
  requestJson<{login: string}>(`${githubApiBase(provider)}/user`, {
    method: "GET",
    headers: githubHeaders(provider),
  }, "GitHub user lookup", options.fetch)

export const ensureGithubForkRepo = async (
  provider: ProviderCfg,
  repoName: string,
  description: string,
  options: ProviderApiOptions = {},
): Promise<{cloneUrl: string; username: string}> => {
  const user = await githubCurrentUser(provider, options)
  const owner = provider.namespace?.trim() || user.login
  const createUrl = owner === user.login
    ? `${githubApiBase(provider)}/user/repos`
    : `${githubApiBase(provider)}/orgs/${encodeURIComponent(owner)}/repos`
  const body = JSON.stringify({
    name: repoName,
    description,
    private: provider.private ?? false,
    auto_init: false,
  })

  try {
    const created = await requestJson<{clone_url: string}>(createUrl, {
      method: "POST",
      headers: githubHeaders(provider),
      body,
    }, "GitHub fork repo create", options.fetch)
    return {cloneUrl: created.clone_url, username: provider.username || user.login}
  } catch (error) {
    if ((error as ApiError).status !== 422) throw error
    const existing = await requestJson<{clone_url: string}>(
      `${githubApiBase(provider)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`,
      {method: "GET", headers: githubHeaders(provider)},
      "GitHub existing fork repo lookup",
      options.fetch,
    ).catch(() => {
      throw error
    })
    return {cloneUrl: existing.clone_url, username: provider.username || user.login}
  }
}

const gitlabApiBase = (provider: ProviderCfg) =>
  (provider.apiBaseUrl || `https://${providerHost(provider.host)}/api/v4`).replace(/\/+$/, "")

const gitlabHeaders = (provider: ProviderCfg) => ({
  "private-token": provider.token,
  "content-type": "application/json",
  "user-agent": "openteam",
})

const gitlabCurrentUser = async (provider: ProviderCfg, options: ProviderApiOptions = {}) =>
  requestJson<{id: number; username: string}>(`${gitlabApiBase(provider)}/user`, {
    method: "GET",
    headers: gitlabHeaders(provider),
  }, "GitLab user lookup", options.fetch)

export const ensureGitlabForkRepo = async (
  provider: ProviderCfg,
  repoName: string,
  description: string,
  options: ProviderApiOptions = {},
): Promise<{cloneUrl: string; username: string}> => {
  const user = await gitlabCurrentUser(provider, options)
  const namespacePath = provider.namespacePath?.trim() || provider.namespace?.trim() || user.username
  const body: Record<string, string | number | boolean> = {
    name: repoName,
    path: repoName,
    description,
    visibility: provider.visibility || (provider.private ? "private" : "public"),
  }
  if (provider.namespaceId !== undefined && provider.namespaceId !== "") {
    body.namespace_id = provider.namespaceId
  }

  try {
    const created = await requestJson<{http_url_to_repo: string}>(`${gitlabApiBase(provider)}/projects`, {
      method: "POST",
      headers: gitlabHeaders(provider),
      body: JSON.stringify(body),
    }, "GitLab fork repo create", options.fetch)
    return {cloneUrl: created.http_url_to_repo, username: provider.username || user.username}
  } catch (error) {
    if (![400, 409].includes((error as ApiError).status ?? 0)) throw error
    const pathWithNamespace = encodeURIComponent(`${namespacePath}/${repoName}`)
    const existing = await requestJson<{http_url_to_repo: string}>(
      `${gitlabApiBase(provider)}/projects/${pathWithNamespace}`,
      {method: "GET", headers: gitlabHeaders(provider)},
      "GitLab existing fork repo lookup",
      options.fetch,
    ).catch(() => {
      throw error
    })
    return {cloneUrl: existing.http_url_to_repo, username: provider.username || user.username}
  }
}

const provisionProviderFork = async (
  app: AppCfg,
  provider: ForkStorageProvider,
  upstream: RepoIdentity,
): Promise<ForkTargetPlan> => {
  const repoName = safe(forkIdentifier(app, upstream))
  const description = `openteam fork of ${upstream.key}`
  const provisioned = provider.kind === "github"
    ? await ensureGithubForkRepo(provider.config, repoName, description)
    : await ensureGitlabForkRepo(provider.config, repoName, description)

  return {
    provider: provider.kind,
    cloneUrls: [provisioned.cloneUrl],
    publishBeforePush: false,
    authUsername: provisioned.username,
  }
}

const normalizeGraspServer = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return ""

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    parsed = new URL(`https://${trimmed}`)
  }

  const host = parsed.host
  const pathname = parsed.pathname.replace(/\/+$/, "")
  const normalized = parsed.protocol === "http:" || parsed.protocol === "ws:"
    ? `http://${host}${pathname}`
    : `${host}${pathname}`
  const npubIndex = normalized.indexOf("npub1")
  return (npubIndex === -1 ? normalized : normalized.slice(0, npubIndex)).replace(/\/+$/, "")
}

const configuredGraspServers = (app: AppCfg) =>
  uniq(app.config.nostr_git.graspServers.map(normalizeGraspServer))

const graspRelayUrl = (server: string) => {
  const normalized = normalizeGraspServer(server)
  if (!normalized) return ""
  return normalized.startsWith("http://")
    ? normalized.replace(/^http:\/\//, "ws://")
    : `wss://${normalized}`
}

const graspCloneUrl = (server: string, ownerNpub: string, identifier: string) => {
  const normalized = normalizeGraspServer(server)
  if (!normalized) return ""
  const prefix = normalized.startsWith("http://") ? "" : "https://"
  return `${prefix}${normalized}/${ownerNpub}/${identifier}.git`
}

const isGraspCloneUrl = (value: string) =>
  /^https?:\/\//i.test(value) && /\.git\/?$/i.test(value) && /npub1[0-9a-z]+/i.test(value)

const graspRelaysFromCloneUrls = (cloneUrls: string[]) =>
  uniq(cloneUrls.filter(isGraspCloneUrl).map(graspRelayUrl).filter(Boolean))

export type RepoRelayPolicy = {
  repoRelays: string[]
  publishRelays: string[]
  naddrRelays: string[]
  taggedRelays: string[]
  isGrasp: boolean
}

type RepoRelayPolicyOptions = {
  target?: string
  sourceHints?: Array<string | undefined>
  relayHints?: string[]
  cloneUrls?: string[]
  relays?: string[]
}

const relayHintsFromTarget = (target?: string) => {
  if (!target) return []
  try {
    return parseDirectRepoRef(target)?.relays ?? []
  } catch {
    return []
  }
}

const repoFallbackRelays = (app: AppCfg, hints: string[]) =>
  normalizeRelays([...hints, ...app.config.nostr_git.repoAnnouncementRelays])

const repoRelayPolicyFromTags = (
  app: AppCfg,
  tags: string[][],
  options: RepoRelayPolicyOptions = {},
): RepoRelayPolicy => {
  const taggedRelays = normalizeRelays([
    ...relayValues(tags, ["relays", "relay"]),
    ...(options.relays ?? []),
  ])
  const cloneUrls = uniq([
    ...tagTailValues(tags, ["clone"]),
    ...(options.cloneUrls ?? []),
  ])
  const relayHints = normalizeRelays([
    ...relayHintsFromTarget(options.target),
    ...(options.sourceHints ?? []).flatMap(relayHintsFromTarget),
    ...(options.relayHints ?? []),
  ])
  const isGrasp = cloneUrls.some(isGraspCloneUrl)
  const repoRelays = isGrasp
    ? taggedRelays
    : normalizeRelays([...taggedRelays, ...repoFallbackRelays(app, relayHints)])
  const publishRelays = isGrasp
    ? repoRelays
    : normalizeRelays([
      ...repoRelays,
      ...app.config.reporting.outboxRelays,
      ...app.config.nostr_git.gitDataRelays,
    ])

  return {
    repoRelays,
    publishRelays,
    naddrRelays: publishRelays,
    taggedRelays,
    isGrasp,
  }
}

export const resolveRepoRelayPolicy = (
  app: AppCfg,
  identity: Pick<RepoIdentity, "rawTags" | "cloneUrls" | "relays" | "sourceHint">,
  options: RepoRelayPolicyOptions = {},
) =>
  repoRelayPolicyFromTags(app, identity.rawTags, {
    ...options,
    cloneUrls: [...identity.cloneUrls, ...(options.cloneUrls ?? [])],
    relays: [...identity.relays, ...(options.relays ?? [])],
    sourceHints: [identity.sourceHint, ...(options.sourceHints ?? [])],
  })

const clonePathLeaf = (value: string) => {
  const url = new URL(value)
  const leaf = url.pathname.split("/").filter(Boolean).pop() ?? ""
  return leaf.replace(/\.git$/, "")
}

const replaceClonePathLeaf = (leaf: string, repo: string) => leaf.endsWith(".git") ? `${repo}.git` : repo

const fillTemplate = (template: string, vars: Record<string, string>) =>
  template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => vars[key] ?? "")

const sameOwnerSegment = (segment: string, upstream: RepoIdentity) => {
  const decoded = decodeSegment(segment)
  if (decoded === upstream.ownerNpub) return "npub"
  if (decoded === upstream.ownerPubkey) return "hex"
  return ""
}

type ForkClonePlan = {
  cloneUrls: string[]
  publishBeforePush: boolean
}

export const deriveForkClonePlan = (
  app: AppCfg,
  upstream: RepoIdentity,
  upstreamCloneUrl: string,
  owner: {npub: string; pubkey: string},
): ForkClonePlan => {
  if (!smartHttpUrl(upstreamCloneUrl)) {
    throw new Error(`orchestrator fork creation requires a Git smart HTTP clone URL, got ${upstreamCloneUrl}`)
  }

  const upstreamUrl = new URL(upstreamCloneUrl)
  const segments = upstreamUrl.pathname.split("/").filter(Boolean)
  const upstreamCloneRepo = clonePathLeaf(upstreamCloneUrl)
  const forkOwner = app.config.nostr_git.forkGitOwner.trim()
  const forkId = forkIdentifier(app, upstream)
  const template = app.config.nostr_git.forkCloneUrlTemplate.trim()

  const vars = {
    owner: owner.npub,
    ownerPubkey: owner.pubkey,
    ownerNpub: owner.npub,
    forkOwner: forkOwner || owner.npub,
    repo: forkId,
    repoName: upstream.identifier,
    forkRepo: forkId,
    forkIdentifier: forkId,
    upstreamOwner: segments.length >= 2 ? segments[segments.length - 2] : "",
    upstreamRepo: upstream.identifier,
    upstreamCloneRepo,
    upstreamIdentifier: upstream.identifier,
    upstreamOwnerNpub: upstream.ownerNpub,
    upstreamOwnerPubkey: upstream.ownerPubkey,
  }

  if (template) {
    const cloneUrl = fillTemplate(template, vars)
    return {cloneUrls: [cloneUrl], publishBeforePush: isGraspCloneUrl(cloneUrl)}
  }

  const graspCloneUrls = configuredGraspServers(app)
    .map(server => graspCloneUrl(server, owner.npub, forkId))
    .filter(Boolean)
  if (graspCloneUrls.length > 0) {
    return {cloneUrls: graspCloneUrls, publishBeforePush: true}
  }

  const ownerIndex = segments.findIndex(segment => sameOwnerSegment(segment, upstream))
  if (ownerIndex !== -1 && segments.length >= 2) {
    const ownerShape = sameOwnerSegment(segments[ownerIndex], upstream)
    segments[ownerIndex] = ownerShape === "hex" ? owner.pubkey : owner.npub
    segments[segments.length - 1] = replaceClonePathLeaf(segments[segments.length - 1], forkId)
    upstreamUrl.pathname = `/${segments.join("/")}`
    const cloneUrl = upstreamUrl.toString()
    return {cloneUrls: [cloneUrl], publishBeforePush: isGraspCloneUrl(cloneUrl)}
  }

  if (!forkOwner || segments.length < 2) {
    throw new Error([
      "cannot infer orchestrator fork clone URL from the announced clone URL",
      `upstream clone URL: ${upstreamCloneUrl}`,
      "Expected a clone URL path containing the upstream owner npub/pubkey, or configure nostr_git.forkCloneUrlTemplate.",
      "Repo identity is still the Nostr announcement <owner npub>/<repo d-tag>; .git only belongs to Git clone URLs.",
    ].join("\n"))
  }

  segments[segments.length - 2] = forkOwner
  segments[segments.length - 1] = replaceClonePathLeaf(segments[segments.length - 1], forkId)
  upstreamUrl.pathname = `/${segments.join("/")}`
  const cloneUrl = upstreamUrl.toString()
  return {cloneUrls: [cloneUrl], publishBeforePush: isGraspCloneUrl(cloneUrl)}
}

export const deriveForkCloneUrl = (
  app: AppCfg,
  upstream: RepoIdentity,
  upstreamCloneUrl: string,
  owner: {npub: string; pubkey: string},
) => deriveForkClonePlan(app, upstream, upstreamCloneUrl, owner).cloneUrls[0]

export const pushForkTargets = (
  forkUrls: string[],
  upstreamCloneUrl: string,
  push: (forkUrl: string) => void,
) => {
  const pushed: string[] = []
  const failures: string[] = []

  for (const forkUrl of forkUrls) {
    try {
      push(forkUrl)
      pushed.push(forkUrl)
    } catch (error) {
      failures.push(`${forkUrl}: ${String(error)}`)
    }
  }

  if (pushed.length === 0) {
    throw new Error([
      `failed to populate orchestrator fork`,
      `upstream: ${upstreamCloneUrl}`,
      "Create a writable empty Git smart-HTTP repository, configure credentials, or use configured GRASP servers for orchestrator-owned fork storage.",
      ...failures,
    ].join("\n"))
  }

  if (failures.length > 0) {
    process.stderr.write(`some fork push targets failed:\n${failures.join("\n")}\n`)
  }

  return pushed
}

const populateForkRemotes = async (
  app: AppCfg,
  upstream: RepoIdentity,
  upstreamCloneUrl: string,
  forkUrls: string[],
  authUsername?: string,
) => {
  const mirror = await ensureMirror(app, upstream, upstreamCloneUrl)
  return pushForkTargets(forkUrls, upstreamCloneUrl, forkUrl => {
    runGit(["push", forkUrl, "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"], mirror, gitAuthEnv(app, forkUrl, authUsername))
  })
}

const forkRelays = (app: AppCfg, upstream: RepoIdentity, forkCloneUrls: string[]) => {
  const graspRelays = graspRelaysFromCloneUrls(forkCloneUrls)
  if (graspRelays.length > 0) {
    return repoRelayPolicyFromTags(app, [
      ["clone", ...forkCloneUrls],
      ["relays", ...graspRelays],
    ], {sourceHints: [upstream.sourceHint]}).repoRelays
  }

  return repoRelayPolicyFromTags(app, [
    ["clone", ...forkCloneUrls],
    ...(upstream.relays.length > 0 ? [["relays", ...upstream.relays]] : []),
  ], {sourceHints: [upstream.sourceHint]}).repoRelays
}

const repoPublishRelays = (app: AppCfg, tags: string[][], sourceHints: Array<string | undefined> = []) =>
  repoRelayPolicyFromTags(app, tags, {sourceHints}).publishRelays

export const forkEventTags = (app: AppCfg, upstream: RepoIdentity, forkCloneUrls: string[], upstreamCloneUrl: string) => {
  const id = forkIdentifier(app, upstream)
  const tags: string[][] = [
    ["d", id],
    ["name", upstream.name ? `${upstream.name} orchestrator fork` : id],
    ["clone", ...forkCloneUrls],
    ["a", upstream.key],
    ["fork", upstream.key],
    ["upstream", upstream.key],
    ["upstream-clone", upstreamCloneUrl],
  ]

  if (upstream.defaultBranch) {
    tags.push(["HEAD", upstream.defaultBranch])
  }

  const relays = forkRelays(app, upstream, forkCloneUrls)
  if (relays.length > 0) {
    tags.push(["relays", ...relays])
  }

  return tags
}

const discoverOrchestratorFork = async (app: AppCfg, ownerPubkey: string, upstream: RepoIdentity) => {
  const relays = uniq([
    ...upstream.relays,
    ...await ownerOutboxRelays(app, ownerPubkey, upstream.relays),
    ...ownerRelayDiscoveryRelays(app, upstream.relays),
  ])
  if (relays.length === 0) return

  const expectedD = forkIdentifier(app, upstream)
  const direct = await queryEvents(relays, {
    kinds: [KIND_REPO_ANNOUNCEMENT],
    authors: [ownerPubkey],
    "#d": [expectedD],
    limit: 20,
  }).catch(() => []) as RepoAnnouncementEvent[]

  const broad = direct.length > 0 ? direct : await queryEvents(relays, {
    kinds: [KIND_REPO_ANNOUNCEMENT],
    authors: [ownerPubkey],
    limit: 200,
  }).catch(() => []) as RepoAnnouncementEvent[]

  const event = latest(broad.filter(item => {
    const id = firstTag(item.tags, ["d"])
    const linked = item.tags.some(tag => tag.slice(1).includes(upstream.key))
    return id === expectedD || linked
  }))

  return event ? identityFromEvent(event) : undefined
}

const saveFork = async (app: AppCfg, fork: RepoFork, identity: RepoIdentity, upstream: RepoIdentity) => {
  const registry = await loadRepoRegistry(app)
  registry.repos[upstream.key] = upstream
  registry.repos[identity.key] = identity
  registry.forks[upstream.key] = fork
  await saveRepoRegistry(app, registry)
}

const forkRecord = (
  upstream: RepoIdentity,
  identity: RepoIdentity,
  upstreamCloneUrl: string,
  forkCloneUrls: string[],
  provider: RepoFork["provider"],
  authUsername?: string,
): RepoFork => ({
  upstreamKey: upstream.key,
  forkKey: identity.key,
  ownerPubkey: identity.ownerPubkey,
  ownerNpub: identity.ownerNpub,
  forkIdentifier: identity.identifier,
  forkAnnouncementEventId: identity.announcementEventId,
  upstreamCloneUrl,
  forkCloneUrl: forkCloneUrls[0],
  forkCloneUrls,
  authUsername,
  provider,
  createdAt: now(),
  updatedAt: now(),
})

const publishForkAnnouncement = async (
  app: AppCfg,
  upstream: RepoIdentity,
  upstreamCloneUrl: string,
  forkCloneUrls: string[],
  owner: Awaited<ReturnType<typeof orchestratorOwner>>,
) => {
  const tags = forkEventTags(app, upstream, forkCloneUrls, upstreamCloneUrl)
  const relays = repoPublishRelays(app, tags, [upstream.sourceHint])
  if (relays.length === 0) {
    throw new Error("cannot announce orchestrator fork because no repo announcement publish relays are available")
  }
  const publish = await publishEventDetailed(relays, {
    kind: KIND_REPO_ANNOUNCEMENT,
    created_at: nowSec(),
    tags,
    content: "",
  }, secretKey(owner.signer))

  return {
    key: repoKey(owner.pubkey, forkIdentifier(app, upstream)),
    ownerPubkey: owner.pubkey,
    ownerNpub: owner.npub,
    identifier: forkIdentifier(app, upstream),
    announcementEventId: publish.eventId,
    announcedAt: nowSec(),
    relays: forkRelays(app, upstream, forkCloneUrls),
    cloneUrls: forkCloneUrls,
    name: upstream.name ? `${upstream.name} orchestrator fork` : forkIdentifier(app, upstream),
    defaultBranch: upstream.defaultBranch,
    rawTags: tags,
  } satisfies RepoIdentity
}

const ensureOrchestratorFork = async (app: AppCfg, upstream: RepoIdentity, upstreamCloneUrl: string) => {
  const owner = await orchestratorOwner(app)
  if (upstream.ownerPubkey === owner.pubkey) {
    return {identity: upstream, source: upstreamCloneUrl, authUsername: undefined}
  }

  const registry = await loadRepoRegistry(app)
  const existingFork = registry.forks[upstream.key]
  const existingIdentity = existingFork ? registry.repos[existingFork.forkKey] : undefined
  if (existingFork && existingIdentity?.cloneUrls.length) {
    const existingCloneUrls = uniq([
      ...(existingFork.forkCloneUrls ?? []),
      existingFork.forkCloneUrl,
      ...existingIdentity.cloneUrls,
    ])
    return {
      identity: existingIdentity,
      source: existingCloneUrls[0],
      upstream,
      fork: existingFork,
      authUsername: existingFork.authUsername,
    }
  }

  const announced = await discoverOrchestratorFork(app, owner.pubkey, upstream)
  if (announced?.cloneUrls.length) {
    const fork = forkRecord(upstream, announced, upstreamCloneUrl, announced.cloneUrls, "announced")
    await saveFork(app, fork, announced, upstream)
    return {
      identity: announced,
      source: announced.cloneUrls[0],
      upstream,
      fork,
      authUsername: undefined,
    }
  }

  const saveFromTarget = async (target: ForkTargetPlan) => {
    let forkIdentity: RepoIdentity
    let pushedCloneUrls: string[]

    if (target.publishBeforePush) {
      forkIdentity = await publishForkAnnouncement(app, upstream, upstreamCloneUrl, target.cloneUrls, owner)
      await delay(5000)
      pushedCloneUrls = await populateForkRemotes(app, upstream, upstreamCloneUrl, target.cloneUrls, target.authUsername)
      if (pushedCloneUrls.length !== target.cloneUrls.length) {
        forkIdentity = await publishForkAnnouncement(app, upstream, upstreamCloneUrl, pushedCloneUrls, owner)
      }
    } else {
      pushedCloneUrls = await populateForkRemotes(app, upstream, upstreamCloneUrl, target.cloneUrls, target.authUsername)
      forkIdentity = await publishForkAnnouncement(app, upstream, upstreamCloneUrl, pushedCloneUrls, owner)
    }

    const fork = forkRecord(upstream, forkIdentity, upstreamCloneUrl, pushedCloneUrls, target.provider, target.authUsername)
    await saveFork(app, fork, forkIdentity, upstream)

    return {
      identity: forkIdentity,
      source: pushedCloneUrls[0],
      upstream,
      fork,
      authUsername: target.authUsername,
    }
  }

  const failures: string[] = []
  const explicitTemplate = app.config.nostr_git.forkCloneUrlTemplate.trim()

  if (!explicitTemplate) {
    for (const provider of configuredForkProviders(app)) {
      try {
        return await saveFromTarget(await provisionProviderFork(app, provider, upstream))
      } catch (error) {
        failures.push(`${provider.kind}: ${gitError(error)}`)
      }
    }
  }

  try {
    const plan = deriveForkClonePlan(app, upstream, upstreamCloneUrl, owner)
    return await saveFromTarget({
      provider: plan.cloneUrls.some(isGraspCloneUrl) ? "grasp" : "git-smart-http",
      ...plan,
    })
  } catch (error) {
    if (failures.length === 0) throw error
    throw new Error([
      "failed to create an orchestrator-owned fork in any configured fork target",
      ...failures,
      `fallback: ${gitError(error)}`,
    ].join("\n"))
  }
}

const cachedByDirectRef = (registry: RepoRegistry, direct: DirectRepoRef) =>
  registry.repos[repoKey(direct.ownerPubkey, direct.identifier)]

const cachedByHint = (registry: RepoRegistry, hint: string) => {
  const hints = localHintValues(hint).map(comparable)
  return Object.values(registry.repos).filter(identity => {
    const candidates = uniq([
      identity.key,
      `${identity.ownerNpub}/${identity.identifier}`,
      identity.identifier,
      identity.name ?? "",
      identity.sourceHint ?? "",
      ...identity.cloneUrls,
    ]).map(comparable)
    return hints.some(hintValue => candidates.some(candidate => candidate === hintValue || candidate.endsWith(`/${hintValue}`)))
  })
}

const ownerRelayDiscoveryRelays = (app: AppCfg, hints: string[]) =>
  uniq([
    ...hints,
    ...repoDiscoveryRelays(app),
    ...DEFAULT_REPO_DISCOVERY_RELAYS,
  ].map(normalizeRelay).filter(isRelayLikeUrl))

const ownerOutboxRelays = async (app: AppCfg, ownerPubkey: string, hints: string[]) => {
  const relays = ownerRelayDiscoveryRelays(app, hints)
  if (relays.length === 0) return []

  const events = await queryEvents(relays, {
    kinds: [KIND_OUTBOX_RELAYS],
    authors: [ownerPubkey],
    limit: 20,
  }).catch(() => []) as RepoAnnouncementEvent[]

  return uniq(
    [...events]
      .sort((a, b) => b.created_at - a.created_at)
      .flatMap(event => relayValues(event.tags, ["r", "relay"])),
  )
}

const discoverByDirectRef = async (app: AppCfg, registry: RepoRegistry, direct: DirectRepoRef) => {
  const relays = uniq([
    ...direct.relays,
    ...await ownerOutboxRelays(app, direct.ownerPubkey, direct.relays),
    ...ownerRelayDiscoveryRelays(app, direct.relays),
  ])
  if (relays.length === 0) {
    const cached = cachedByDirectRef(registry, direct)
    if (cached) return cached
    throw new Error("no Nostr repo announcement relays configured")
  }

  const events = await queryEvents(relays, {
    kinds: [KIND_REPO_ANNOUNCEMENT],
    authors: [direct.ownerPubkey],
    "#d": [direct.identifier],
    limit: 20,
  }).catch(() => []) as RepoAnnouncementEvent[]

  const event = latest(events)
  if (!event) {
    const cached = cachedByDirectRef(registry, direct)
    if (cached) return cached
    throw new Error(`repo announcement not found for ${repoKey(direct.ownerPubkey, direct.identifier)}`)
  }

  return identityFromEvent(event)
}

const discoverByHint = async (app: AppCfg, registry: RepoRegistry, hint: string) => {
  const cached = cachedByHint(registry, hint)
  if (cached.length === 1) return cached[0]
  if (cached.length > 1) {
    throw new Error(`target ${hint} matches multiple cached Nostr repo announcements; use ${KIND_REPO_ANNOUNCEMENT}:<owner>:<d>`)
  }

  const relays = repoDiscoveryRelays(app)
  if (relays.length === 0) {
    throw new Error(`target ${hint} is only a hint; configure nostr_git.repoAnnouncementRelays to resolve kind ${KIND_REPO_ANNOUNCEMENT} repo announcements`)
  }

  const events = await queryEvents(relays, {
    kinds: [KIND_REPO_ANNOUNCEMENT],
    limit: 500,
  }).catch(() => []) as RepoAnnouncementEvent[]

  const matches = events
    .map(event => ({event, identity: identityFromEvent(event, hint)}))
    .filter((item): item is {event: RepoAnnouncementEvent; identity: RepoIdentity} => Boolean(item.identity))
    .filter(item => matchesHint(item.identity, item.event, hint))

  const byKey = new Map<string, {event: RepoAnnouncementEvent; identity: RepoIdentity}>()
  for (const match of matches) {
    const previous = byKey.get(match.identity.key)
    if (!previous || previous.event.created_at < match.event.created_at) {
      byKey.set(match.identity.key, match)
    }
  }

  const unique = [...byKey.values()]
  if (unique.length === 0) {
    throw new Error(`target ${hint} did not resolve to a Nostr repo announcement; announce the repository first with your Nostr-git client`)
  }
  if (unique.length > 1) {
    throw new Error(`target ${hint} matches multiple Nostr repo announcements; use ${KIND_REPO_ANNOUNCEMENT}:<owner>:<d>`)
  }

  return unique[0].identity
}

const resolveRepoIdentity = async (app: AppCfg, profile: TargetProfile) => {
  if (!profile.hint) {
    throw new Error("repository target is required; openteam only works on Nostr-announced repositories")
  }

  const registry = await loadRepoRegistry(app)
  const direct = parseDirectRepoRef(profile.hint)
  const identity = direct
    ? await discoverByDirectRef(app, registry, direct)
    : await discoverByHint(app, registry, profile.hint)

  if (!identity) {
    throw new Error(`unable to resolve ${profile.hint} to a Nostr repo announcement`)
  }

  const next = await loadRepoRegistry(app)
  next.repos[identity.key] = {...identity, sourceHint: profile.hint}
  await saveRepoRegistry(app, next)
  return next.repos[identity.key]
}

export const resolveRepoAnnouncementTarget = async (app: AppCfg, agent: PreparedAgent, target?: string) => {
  const profile = targetProfile(app, agent, target)
  const identity = await resolveRepoIdentity(app, profile)
  return {
    repo: profile.profile,
    identity,
    target: profile.label,
  }
}

const cloneSources = (identity: RepoIdentity, hint?: string) => {
  const hints = hint ? localHintValues(hint).filter(value => isUrl(value) || existsSync(value)) : []
  const sources = uniq([...hints, ...identity.cloneUrls]).filter(value => isUrl(value) || existsSync(value))
  if (sources.length === 0) {
    throw new Error(`repo ${identity.key} has no usable clone URL; add a clone/url tag to its ${KIND_REPO_ANNOUNCEMENT} announcement`)
  }
  return sources
}

const mirrorPath = (app: AppCfg, identity: RepoIdentity) =>
  path.join(app.config.runtimeRoot, "repos", "object-cache", identity.ownerNpub, `${safe(identity.identifier)}.git`)

const contextPath = (app: AppCfg, identity: RepoIdentity, id: string) =>
  path.join(app.config.runtimeRoot, "repos", "contexts", identity.ownerNpub, safe(identity.identifier), id)

const gitError = (error: unknown) => error instanceof Error ? error.message : String(error)

const ensureMirror = async (
  app: AppCfg,
  identity: RepoIdentity,
  source: string,
  upstreamSource?: string,
  authUsername?: string,
) => {
  const mirror = mirrorPath(app, identity)
  await ensureDir(path.dirname(mirror))

  if (!existsSync(mirror)) {
    const tmp = `${mirror}.tmp-${process.pid}-${Date.now()}`
    try {
      runGit(["clone", "--mirror", source, tmp], process.env.OPENTEAM_CALLER_CWD || process.cwd(), gitAuthEnv(app, source, authUsername))
      await rename(tmp, mirror)
    } catch (error) {
      await rm(tmp, {recursive: true, force: true})
      throw error
    }
  } else {
    runGit(["remote", "set-url", "origin", source], mirror)
    runGit(["fetch", "--prune", "origin"], mirror, gitAuthEnv(app, source, authUsername))
  }

  if (upstreamSource && upstreamSource !== source) {
    if (tryGit(["remote", "get-url", "upstream"], mirror)) {
      runGit(["remote", "set-url", "upstream", upstreamSource], mirror)
    } else {
      runGit(["remote", "add", "upstream", upstreamSource], mirror)
    }
    runGit(["fetch", "--prune", "upstream", "+refs/heads/*:refs/remotes/upstream/*"], mirror, gitAuthEnv(app, upstreamSource))
  }

  return mirror
}

const ensureMirrorFromSources = async (
  app: AppCfg,
  identity: RepoIdentity,
  sources: string[],
  upstreamSource?: string,
  authUsername?: string,
) => {
  const attempted: string[] = []
  let lastError: unknown

  for (const source of sources) {
    attempted.push(source)
    try {
      return {
        mirror: await ensureMirror(app, identity, source, upstreamSource, authUsername),
        source,
      }
    } catch (error) {
      lastError = error
    }
  }

  throw new Error([
    `failed to mirror ${identity.key}`,
    `tried: ${attempted.join(", ")}`,
    `last error: ${gitError(lastError)}`,
  ].join("\n"))
}

const resolveBaseCommit = (mirror: string, baseRef: string) => {
  const candidates = uniq([
    `${baseRef}^{commit}`,
    `refs/heads/${baseRef}^{commit}`,
    `refs/remotes/origin/${baseRef}^{commit}`,
    `refs/remotes/upstream/${baseRef}^{commit}`,
    "HEAD^{commit}",
  ])

  for (const candidate of candidates) {
    const commit = tryGit(["rev-parse", "--verify", candidate], mirror)
    if (commit) return commit
  }

  throw new Error(`unable to resolve base ref ${baseRef} in ${mirror}`)
}

const lease = (context: RepoContext, agent: PreparedAgent, item: TaskItem, mode: TaskMode): RepoContext => ({
  ...context,
  state: "leased",
  lease: {
    workerId: agent.id,
    baseAgentId: agent.configId,
    role: agent.agent.role,
    jobId: item.id,
    mode,
    parallel: item.parallel,
    leasedAt: now(),
  },
  updatedAt: now(),
})

const configureContextGitAuth = async (
  app: AppCfg,
  checkout: string,
  remoteUrls: string[],
  authUsername?: string,
) => {
  const auth = await configureCheckoutGitAuth(app, checkout, remoteUrls, authUsername)
  if (!auth) return
  runGit(["config", "--local", "--replace-all", "credential.helper", ""], checkout)
  runGit(["config", "--local", "--add", "credential.helper", auth.helperCommand], checkout)
  runGit(["config", "--local", "--replace-all", "credential.useHttpPath", "true"], checkout)
}

const createContext = async (
  app: AppCfg,
  identity: RepoIdentity,
  source: string,
  mirror: string,
  mode: TaskMode,
  baseRef: string,
  baseCommit: string,
  agent: PreparedAgent,
  item: TaskItem,
  upstreamRepoKey?: string,
  upstreamSource?: string,
  authUsername?: string,
) => {
  const id = safe(`${agent.agent.role}-${mode}-${item.id}-${Date.now().toString(36)}`)
  const root = contextPath(app, identity, id)
  const checkout = path.join(root, "checkout")
  const branch = `openteam/${identity.ownerNpub}/${safe(identity.identifier)}/${id}`

  await ensureDir(root)
  runGit(["clone", "--reference", mirror, "--dissociate", source, checkout], process.env.OPENTEAM_CALLER_CWD || process.cwd(), gitAuthEnv(app, source, authUsername))
  await configureContextGitAuth(app, checkout, [source, ...(upstreamSource ? [upstreamSource] : [])], authUsername)
  if (!hasCommit(checkout, baseCommit)) {
    runGit(["fetch", mirror, "+refs/*:refs/remotes/openteam-cache/*"], checkout)
  }
  if (upstreamSource && upstreamSource !== source) {
    runGit(["remote", "add", "upstream", upstreamSource], checkout)
  }
  runGit(["checkout", "-B", branch, baseCommit], checkout)

  const context: RepoContext = {
    id,
    repoKey: identity.key,
    upstreamRepoKey,
    path: root,
    checkout,
    mirror,
    mode,
    baseRef,
    baseCommit,
    branch,
    state: "idle",
    createdAt: now(),
    updatedAt: now(),
  }

  return lease(context, agent, item, mode)
}

const resolveContinuationContext = async (
  app: AppCfg,
  registry: RepoRegistry,
  agent: PreparedAgent,
  item: TaskItem,
  profile: TargetProfile,
): Promise<ResolvedRepoTarget | undefined> => {
  const contextId = item.continuation?.contextId
  if (!contextId) return

  const context = registry.contexts[contextId]
  if (!context) {
    throw new Error(`continuation context not found: ${contextId}`)
  }
  if (context.state !== "idle") {
    throw new Error(`continuation context ${contextId} is busy; stop the active run or wait until the context is idle before continuing`)
  }
  if (!existsSync(context.checkout)) {
    throw new Error(`continuation context ${contextId} checkout is missing: ${context.checkout}`)
  }

  const requestedMode = item.mode ?? context.mode
  if (requestedMode !== context.mode) {
    throw new Error(`continuation context ${contextId} was created for ${context.mode} mode; relaunch with --mode ${context.mode} or start a new run`)
  }

  const identity = registry.repos[context.repoKey]
  if (!identity) {
    throw new Error(`continuation context ${contextId} references unknown repo ${context.repoKey}`)
  }
  const upstreamIdentity = context.upstreamRepoKey ? registry.repos[context.upstreamRepoKey] : undefined
  if (context.upstreamRepoKey && !upstreamIdentity) {
    throw new Error(`continuation context ${contextId} references unknown upstream repo ${context.upstreamRepoKey}`)
  }
  const fork = context.upstreamRepoKey
    ? registry.forks[context.upstreamRepoKey]
    : Object.values(registry.forks).find(item => item.forkKey === identity.key)
  const remoteUrls = uniq([
    ...(fork?.forkCloneUrls ?? []),
    ...(fork?.forkCloneUrl ? [fork.forkCloneUrl] : []),
    ...identity.cloneUrls,
    ...(upstreamIdentity?.cloneUrls ?? []),
  ])
  await configureContextGitAuth(app, context.checkout, remoteUrls, fork?.authUsername)

  const leased = lease(context, agent, item, context.mode)
  registry.contexts[context.id] = leased
  registry.repos[identity.key] = identity
  if (upstreamIdentity) registry.repos[upstreamIdentity.key] = upstreamIdentity
  await saveRepoRegistry(app, registry)

  return {
    repo: {
      ...profile.profile,
      root: leased.checkout,
      baseBranch: leased.branch,
    },
    identity,
    upstreamIdentity,
    fork,
    context: leased,
    target: profile.label || identity.key,
  }
}

export const resolveRepoTarget = async (
  app: AppCfg,
  agent: PreparedAgent,
  item: TaskItem,
): Promise<ResolvedRepoTarget> => {
  return withRepoRegistryLock(app, async () => {
    const profile = targetProfile(app, agent, item.target)
    const registry = await loadRepoRegistry(app)
    const continuation = await resolveContinuationContext(app, registry, agent, item, profile)
    if (continuation) return continuation

    const mode = item.mode ?? profile.profile.mode ?? "web"
    const upstreamIdentity = await resolveRepoIdentity(app, profile)
    const upstreamSources = cloneSources(upstreamIdentity, profile.hint)
    const upstreamMirror = await ensureMirrorFromSources(app, upstreamIdentity, upstreamSources)
    const upstreamSource = upstreamMirror.source
    const working = await ensureOrchestratorFork(app, upstreamIdentity, upstreamSource)
    const identity = working.identity
    const workingSources = working.upstream
      ? uniq([working.source, ...cloneSources(identity)])
      : uniq([working.source, ...upstreamSources])
    const workingMirror = working.upstream
      ? await ensureMirrorFromSources(app, identity, workingSources, upstreamSource, working.authUsername)
      : upstreamMirror
    const source = workingMirror.source
    const mirror = workingMirror.mirror
    const baseRef = upstreamIdentity.defaultBranch || identity.defaultBranch || profile.profile.baseBranch || "HEAD"
    const baseCommit = resolveBaseCommit(mirror, baseRef)
    const nextRegistry = await loadRepoRegistry(app)
    const active = Object.values(nextRegistry.contexts).find(context => context.repoKey === identity.key && context.state === "leased")

    if (active && !item.parallel) {
      throw new Error(`repo context ${active.id} is busy for ${identity.key}; enqueue the work or rerun with explicit parallel mode`)
    }

    const reusable = item.parallel || active
      ? undefined
      : Object.values(nextRegistry.contexts).find(context =>
        context.repoKey === identity.key &&
        context.mode === mode &&
        context.baseCommit === baseCommit &&
        context.state === "idle" &&
        existsSync(context.checkout)
      )

    const context = reusable
      ? lease(reusable, agent, item, mode)
      : await createContext(app, identity, source, mirror, mode, baseRef, baseCommit, agent, item, working.upstream?.key, working.upstream ? upstreamSource : undefined, working.authUsername)

    await configureContextGitAuth(app, context.checkout, [source, ...(working.upstream ? [upstreamSource] : [])], working.authUsername)

    nextRegistry.repos[upstreamIdentity.key] = upstreamIdentity
    nextRegistry.repos[identity.key] = identity
    if (working.fork) {
      nextRegistry.forks[working.fork.upstreamKey] = working.fork
    }
    nextRegistry.contexts[context.id] = context
    await saveRepoRegistry(app, nextRegistry)

    return {
      repo: {
        ...profile.profile,
        root: context.checkout,
        baseBranch: context.branch,
      },
      identity,
      upstreamIdentity: working.upstream,
      fork: working.fork,
      context,
      target: profile.label,
    }
  })
}

const leaseMatches = (lease: WorkerLease | undefined, expected: Partial<WorkerLease>) => {
  if (!lease) return false
  return Object.entries(expected).every(([key, value]) => value === undefined || lease[key as keyof WorkerLease] === value)
}

export const releaseRepoContext = async (app: AppCfg, contextId?: string, expectedLease?: Partial<WorkerLease>) => {
  if (!contextId) return false
  let released = false
  await withRepoRegistryLock(app, async () => {
    const registry = await loadRepoRegistry(app)
    const context = registry.contexts[contextId]
    if (!context) return
    if (expectedLease && !leaseMatches(context.lease, expectedLease)) return
    registry.contexts[contextId] = {
      ...context,
      state: "idle",
      lease: undefined,
      updatedAt: now(),
    }
    await saveRepoRegistry(app, registry)
    released = true
  })
  return released
}
