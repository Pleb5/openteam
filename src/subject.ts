import {existsSync} from "node:fs"
import {spawnSync} from "node:child_process"
import path from "node:path"
import {nip19, type Event} from "nostr-tools"
import {queryEvents, secretKey} from "./nostr.js"
import {resolveRepoAnnouncementTarget, resolveRepoRelayPolicy} from "./repo.js"
import type {AppCfg, PreparedAgent, RepoIdentity, ResolvedRepoTarget, ResolvedTaskSubject, TaskSubject} from "./types.js"

type GitSubmodule = {
  name: string
  path: string
  url?: string
}

const uniq = (items: string[]) => Array.from(new Set(items.filter(Boolean)))

const normalizeRelay = (value: string) => value.trim().replace(/\/+$/, "")

const isRelayLikeUrl = (value: string) => {
  try {
    const url = new URL(value)
    return ["ws:", "wss:", "http:", "https:"].includes(url.protocol)
  } catch {
    return false
  }
}

const relayList = (values: string[]) => uniq(values.map(normalizeRelay).filter(isRelayLikeUrl))

export const decodeSubjectEventPointer = (value: string) => {
  const raw = value.startsWith("nostr:") ? value.slice("nostr:".length) : value
  if (/^[a-f0-9]{64}$/i.test(raw)) {
    return {eventId: raw.toLowerCase(), encodedEvent: value, relays: []}
  }

  const decoded = nip19.decode(raw)
  if (decoded.type === "note") {
    return {eventId: String(decoded.data).toLowerCase(), encodedEvent: value, relays: []}
  }
  if (decoded.type === "nevent") {
    const data = decoded.data as {id: string; relays?: string[]}
    return {
      eventId: data.id.toLowerCase(),
      encodedEvent: value,
      relays: relayList(data.relays ?? []),
    }
  }

  throw new Error(`unsupported subject event pointer ${value}; expected nevent, note, or hex event id`)
}

const git = (cwd: string, args: string[], allowFailure = false) => {
  const result = spawnSync("git", args, {cwd, encoding: "utf8"})
  if (!allowFailure && result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`)
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  }
}

export const readGitSubmodules = async (checkout: string): Promise<GitSubmodule[]> => {
  const gitmodules = path.join(checkout, ".gitmodules")
  if (!existsSync(gitmodules)) return []

  const result = git(checkout, ["config", "--file", gitmodules, "--get-regexp", "^submodule\\..*\\.(path|url)$"], true)
  if (!result.ok && !result.stdout) return []

  const modules = new Map<string, Partial<GitSubmodule>>()
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^submodule\.(.+)\.(path|url)\s+(.+)$/)
    if (!match) continue
    const [, name, key, value] = match
    const current = modules.get(name) ?? {name}
    modules.set(name, {...current, [key]: value})
  }

  return [...modules.values()]
    .filter((item): item is GitSubmodule => Boolean(item.name && item.path))
}

const safeRelativePath = (value: string) => {
  const normalized = path.normalize(value).replace(/\\/g, "/")
  if (path.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`subject path must stay inside the environment checkout: ${value}`)
  }
  return normalized
}

const normalizeRepoUrl = (value: string) => {
  const trimmed = value.trim().replace(/\/+$/, "").replace(/\.git$/i, "")
  try {
    const parsed = new URL(trimmed)
    return `${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "").replace(/\.git$/i, "")}`.toLowerCase()
  } catch {
    return trimmed.toLowerCase()
  }
}

const repoBasename = (value: string) => {
  const normalized = normalizeRepoUrl(value)
  return normalized.split("/").filter(Boolean).at(-1)?.replace(/\.git$/i, "") ?? ""
}

const subjectRepoSummary = (identity: RepoIdentity) => ({
  key: identity.key,
  ownerNpub: identity.ownerNpub,
  identifier: identity.identifier,
})

const submoduleMatchesIdentity = (submodule: GitSubmodule, identity: RepoIdentity) => {
  const identityUrls = new Set(identity.cloneUrls.map(normalizeRepoUrl))
  if (submodule.url && identityUrls.has(normalizeRepoUrl(submodule.url))) return true
  if (path.basename(submodule.path) === identity.identifier) return true
  if (submodule.url && repoBasename(submodule.url) === identity.identifier) return true
  return false
}

const findSubjectSubmodule = (submodules: GitSubmodule[], identity: RepoIdentity) => {
  const matches = submodules.filter(submodule => submoduleMatchesIdentity(submodule, identity))
  if (matches.length === 0) {
    throw new Error(`subject repo ${identity.key} is not present as a submodule in the environment checkout`)
  }
  if (matches.length > 1) {
    throw new Error(`subject repo ${identity.key} matches multiple submodules: ${matches.map(item => item.path).join(", ")}; rerun with --subject-path`)
  }
  return matches[0]
}

const relaysForSubjectEvent = (
  app: AppCfg,
  agent: PreparedAgent,
  environment: ResolvedRepoTarget,
  subjectIdentity: RepoIdentity | undefined,
  pointerRelays: string[],
  subjectTarget?: string,
) => {
  const environmentPolicy = resolveRepoRelayPolicy(app, environment.identity, {target: environment.target})
  const subjectPolicy = subjectIdentity
    ? resolveRepoRelayPolicy(app, subjectIdentity, {target: subjectTarget})
    : undefined
  return relayList([
    ...pointerRelays,
    ...(subjectIdentity?.relays ?? []),
    ...(subjectPolicy?.repoRelays ?? []),
    ...(subjectPolicy?.naddrRelays ?? []),
    ...environment.identity.relays,
    ...environmentPolicy.repoRelays,
    ...app.config.nostr_git.gitDataRelays,
    ...app.config.nostr_git.repoAnnouncementRelays,
  ])
}

export const resolveTaskSubject = async ({
  app,
  agent,
  environment,
  checkout,
  subject,
}: {
  app: AppCfg
  agent: PreparedAgent
  environment: ResolvedRepoTarget
  checkout: string
  subject: TaskSubject
}): Promise<ResolvedTaskSubject> => {
  if (subject.kind !== "repo-pr-event") {
    throw new Error(`unsupported task subject kind ${(subject as {kind?: string}).kind}`)
  }

  const pointer = decodeSubjectEventPointer(subject.eventId)
  const subjectTarget = subject.repoTarget?.trim() || undefined
  const subjectAnnouncement = subjectTarget
    ? await resolveRepoAnnouncementTarget(app, agent, subjectTarget)
    : undefined
  const subjectIdentity = subjectAnnouncement?.identity
  const submodules = await readGitSubmodules(checkout)
  const explicitPath = subject.path ? safeRelativePath(subject.path) : undefined
  const matchedSubmodule = explicitPath
    ? submodules.find(item => safeRelativePath(item.path) === explicitPath)
    : subjectIdentity
      ? findSubjectSubmodule(submodules, subjectIdentity)
      : undefined

  if (!explicitPath && !matchedSubmodule) {
    throw new Error("subject resolution requires --subject-path or --subject-target for environment checkouts")
  }

  const subjectPath = explicitPath ?? matchedSubmodule?.path
  const subjectCheckout = subjectPath ? path.join(checkout, subjectPath) : undefined
  if (subjectCheckout && !existsSync(subjectCheckout)) {
    throw new Error(`subject checkout path is missing after environment preparation: ${subjectPath}`)
  }

  return {
    kind: subject.kind,
    eventId: pointer.eventId,
    encodedEvent: pointer.encodedEvent,
    repoTarget: subjectTarget,
    environmentCheckout: checkout,
    path: subjectPath,
    checkout: subjectCheckout,
    repo: subjectIdentity ? subjectRepoSummary(subjectIdentity) : undefined,
    cloneUrls: subjectIdentity?.cloneUrls,
    relays: relaysForSubjectEvent(app, agent, environment, subjectIdentity, pointer.relays, subjectTarget),
  }
}

const firstTag = (event: Event, names: string[]) =>
  event.tags.find(tag => names.includes(tag[0]))?.[1]

const tagTailValues = (event: Event, names: string[]) =>
  event.tags
    .filter(tag => names.includes(tag[0]))
    .flatMap(tag => tag.slice(1))
    .filter(Boolean)

const firstCommitLikeValue = (event: Event, preferredTags: string[]) => {
  return tagTailValues(event, preferredTags).find(value => /^[a-f0-9]{40,64}$/i.test(value))
}

const hasCommit = (checkout: string, commit: string) =>
  git(checkout, ["cat-file", "-e", `${commit}^{commit}`], true).ok

const fetchCommit = (checkout: string, cloneUrls: string[], commit: string) => {
  const failures: string[] = []
  for (const clone of cloneUrls) {
    const result = git(checkout, ["fetch", "--no-tags", clone, commit], true)
    if (result.ok && hasCommit(checkout, commit)) return {ok: true, failures}
    failures.push(`${clone}: ${result.stderr || "fetch failed"}`)
  }
  return {ok: false, failures}
}

const querySubjectEvent = async (agent: PreparedAgent, subject: ResolvedTaskSubject) => {
  const relays = subject.relays ?? []
  if (relays.length === 0) {
    throw new Error(`subject event ${subject.eventId} has no relays to query`)
  }
  let sk: Uint8Array | undefined
  try {
    sk = secretKey(agent)
  } catch {}
  const events = await queryEvents(relays, {ids: [subject.eventId]}, sk)
  const event = events.find(event => event.id === subject.eventId) as Event | undefined
  if (!event) {
    throw new Error(`subject event ${subject.eventId} was not found on relays: ${relays.join(", ")}`)
  }
  return event
}

export const prepareTaskSubject = async (
  agent: PreparedAgent,
  subject: ResolvedTaskSubject,
): Promise<ResolvedTaskSubject> => {
  if (subject.kind !== "repo-pr-event") return subject
  const event = await querySubjectEvent(agent, subject)
  const tipCommit = firstCommitLikeValue(event, ["c", "commit", "tip", "oid", "r"])
  const baseCommit = firstTag(event, ["merge-base", "base", "base-commit"])
  const targetBranch = firstTag(event, ["branch-name", "target-branch", "branch"])
  const eventCloneUrls = tagTailValues(event, ["clone", "git", "repo", "source"]).filter(value => /^https?:\/\//i.test(value) || existsSync(value))
  const cloneUrls = uniq([...eventCloneUrls, ...(subject.cloneUrls ?? [])])
  const warnings: string[] = []
  let fetched = false
  let checkedOut = false

  if (subject.checkout && tipCommit) {
    const availableBeforeFetch = hasCommit(subject.checkout, tipCommit)
    if (!availableBeforeFetch) {
      const fetch = fetchCommit(subject.checkout, cloneUrls, tipCommit)
      fetched = fetch.ok
      if (!fetch.ok) {
        throw new Error(`subject PR tip ${tipCommit} is not available in ${subject.path}; fetch attempts failed: ${fetch.failures.join("; ") || "no clone URLs"}`)
      }
    }
    git(subject.checkout, ["checkout", "--detach", tipCommit])
    checkedOut = true
  } else if (!tipCommit) {
    warnings.push("subject PR event did not expose a commit tag openteam could identify")
  }

  return {
    ...subject,
    eventKind: event.kind,
    eventAuthor: event.pubkey,
    baseCommit,
    tipCommit,
    targetBranch,
    cloneUrls,
    fetched,
    checkedOut,
    warnings: warnings.length > 0 ? [...(subject.warnings ?? []), ...warnings] : subject.warnings,
  }
}

export const subjectPromptLines = (subject?: ResolvedTaskSubject) => {
  if (!subject) return []
  return [
    `Environment checkout root: ${subject.environmentCheckout ?? "(active checkout root)"}`,
    `Review subject kind: ${subject.kind}`,
    `Review subject event: ${subject.encodedEvent ?? subject.eventId}`,
    subject.repo ? `Review subject repo: ${subject.repo.key}` : subject.repoTarget ? `Review subject repo target: ${subject.repoTarget}` : "",
    subject.path ? `Review subject path inside environment checkout: ${subject.path}` : "",
    subject.checkout ? `Review subject checkout: ${subject.checkout}` : "",
    subject.tipCommit ? `Review subject tip commit: ${subject.tipCommit}` : "",
    subject.baseCommit ? `Review subject base commit: ${subject.baseCommit}` : "",
    `Run provisioning, dependency installation, and verification from the environment checkout root unless repository documentation explicitly says otherwise.`,
    subject.path ? `Inspect source changes inside the review subject path, but do not treat that submodule as a standalone package when the parent workspace owns dependencies or Nix tooling.` : "",
    subject.repo ? `Repo-side PR comments or statuses belong to the review subject repo, not automatically to the environment repo; return findings unless the task explicitly asks you to publish and the subject publish target is unambiguous.` : "",
  ].filter(Boolean)
}
