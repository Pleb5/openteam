import {existsSync} from "node:fs"
import {readFile} from "node:fs/promises"
import {assertAppConfigValid} from "../config-validate.js"
import {evaluateEvidencePolicy, prPublicationDecision} from "../evidence-policy.js"
import {
  buildCommentEvent,
  buildIssueEvent,
  buildLabelEvent,
  buildPullRequestEvent,
  buildPullRequestUpdateEvent,
  buildRoleLabelEvent,
  buildStatusEvent,
  parseRawRepoEvent,
  pullRequestCloneUrlsForTarget,
  publishPolicySummary,
  publishRepoEvent,
  repoMaintainerPubkeys,
  repoAddrForPublishTarget,
  resolveRepoPublishTarget,
  type ExtraTags,
  type RepoPublishScope,
  upstreamPullRequestNeedsClone,
} from "../repo-publish.js"
import {readVerificationResults} from "../verification.js"
import type {AppCfg, TaskRunRecord} from "../types.js"

const value = (args: string[], key: string) => {
  const index = args.indexOf(key)
  if (index === -1) return ""
  return args[index + 1] ?? ""
}

const values = (args: string[], key: string) => {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === key && args[i + 1]) out.push(args[i + 1])
  }
  return out
}

const flag = (args: string[], key: string) => args.includes(key)

const must = (value: string, label: string) => {
  if (!value) throw new Error(`missing ${label}`)
  return value
}

const agentIdForRef = (app: AppCfg, value?: string, fallback = "") => {
  const raw = value || fallback
  if (!raw) throw new Error("missing agentId or role")
  if (app.config.agents[raw]) return raw
  const match = Object.keys(app.config.agents).find(id => app.config.agents[id]?.role === raw)
  if (match) return match
  throw new Error(`unknown agent or role: ${raw}`)
}

const scope = (args: string[]): RepoPublishScope | undefined => {
  const raw = value(args, "--scope")
  if (!raw) return undefined
  if (raw !== "repo" && raw !== "upstream") {
    throw new Error(`invalid --scope ${raw}`)
  }
  return raw
}

const repoPublishOpts = (app: AppCfg, args: string[]) => {
  const agentRaw = value(args, "--agent")
  return {
    context: value(args, "--context") || undefined,
    agentId: agentRaw ? agentIdForRef(app, agentRaw) : undefined,
    target: value(args, "--target") || undefined,
    scope: scope(args),
    dryRun: flag(args, "--dry-run"),
  }
}

const readStdin = async () => new Promise<string>((resolve, reject) => {
  let body = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", chunk => {
    body += chunk
  })
  process.stdin.on("end", () => resolve(body))
  process.stdin.on("error", reject)
})

const readTextArg = async (args: string[], name: string) => {
  const file = value(args, `${name}-file`)
  if (file) {
    return file === "-" ? await readStdin() : await readFile(file, "utf8")
  }
  return value(args, name)
}

const extraTags = (args: string[]): ExtraTags => {
  const fromSpec = values(args, "--tag").map(spec => {
    const index = spec.indexOf("=")
    if (index === -1) throw new Error(`invalid --tag ${spec}; use name=value or name=value1,value2`)
    const name = spec.slice(0, index).trim()
    const raw = spec.slice(index + 1).trim()
    if (!name || !raw) throw new Error(`invalid --tag ${spec}`)
    return [name, ...raw.split(",").map(item => item.trim()).filter(Boolean)]
  })
  const fromJson = values(args, "--tag-json").map(spec => {
    const parsed = JSON.parse(spec)
    if (!Array.isArray(parsed) || !parsed.every(item => typeof item === "string")) {
      throw new Error(`invalid --tag-json ${spec}; expected JSON string array`)
    }
    return parsed as string[]
  })
  return [...fromSpec, ...fromJson]
}

const printRepoPublishResult = (value: unknown) => {
  console.log(JSON.stringify(value, null, 2))
}

const unique = (items: string[]) => Array.from(new Set(items.filter(Boolean)))

const readRunRecordFromEnv = async () => {
  const file = process.env.OPENTEAM_RUN_FILE
  if (!file || !existsSync(file)) return undefined
  return JSON.parse(await readFile(file, "utf8")) as TaskRunRecord
}

const draftRequested = (args: string[]) => {
  const labels = values(args, "--label").map(item => item.toLowerCase())
  return flag(args, "--draft") || flag(args, "--wip") || labels.some(label => label === "draft" || label === "wip")
}

const draftLabels = (args: string[]) => [
  ...(flag(args, "--draft") ? ["draft"] : []),
  ...(flag(args, "--wip") ? ["wip"] : []),
]

const draftTagExtras = (args: string[]) => draftLabels(args).map(label => ["t", label])

export const pullRequestTargetBranch = (args: string[]) => {
  const legacy = value(args, "--branch")
  if (legacy) {
    throw new Error([
      "--branch is ambiguous and no longer maps to NIP-34 branch-name.",
      "Use --target-branch for the merge target branch.",
      "Do not pass the worker/source branch as branch-name; the source is represented by --tip plus source fork --clone URLs.",
    ].join(" "))
  }
  return value(args, "--target-branch") || undefined
}

const pullRequestRecipients = (
  target: Awaited<ReturnType<typeof resolveRepoPublishTarget>>,
  args: string[],
) => unique([
  ...values(args, "--p"),
  ...repoMaintainerPubkeys(target.identity),
])

const pullRequestCloneUrls = (
  target: Awaited<ReturnType<typeof resolveRepoPublishTarget>>,
  args: string[],
) => {
  const clone = pullRequestCloneUrlsForTarget(target, values(args, "--clone"))
  if (upstreamPullRequestNeedsClone(target) && clone.length === 0) {
    throw new Error([
      "upstream PR publication needs source fork clone URLs.",
      "The active repo context does not contain clone URLs for the orchestrator-owned fork; pass --clone <url> or repair the repo context.",
    ].join(" "))
  }
  return clone
}

const pullRequestPublicationPolicy = async (
  target: Awaited<ReturnType<typeof resolveRepoPublishTarget>>,
  args: string[],
) => {
  const record = await readRunRecordFromEnv()
  const checkout = target.context?.checkout || record?.context?.checkout
  const fileResults = checkout ? await readVerificationResults(checkout).catch(() => []) : []
  const recordResults = record?.verification?.results ?? []
  const results = fileResults.length > 0 ? fileResults : recordResults
  const policy = evaluateEvidencePolicy(record?.doneContract, results)
  const decision = prPublicationDecision(policy, {draft: draftRequested(args)})
  return {
    ...policy,
    allowed: decision.allowed,
    reason: decision.reason,
    draft: draftRequested(args),
    runId: record?.runId,
    resultsSource: fileResults.length > 0 ? "checkout" : recordResults.length > 0 ? "run-record" : "none",
  }
}

const assertPullRequestPublicationAllowed = async (
  target: Awaited<ReturnType<typeof resolveRepoPublishTarget>>,
  args: string[],
  dryRun: boolean,
) => {
  const policy = await pullRequestPublicationPolicy(target, args)
  if (dryRun || policy.allowed) return policy
  throw new Error([
    `PR publication blocked: ${policy.reason}`,
    `evidence level: ${policy.level}`,
    ...policy.prBlockers.map(blocker => `blocker: ${blocker}`),
    "Record verification evidence first, or explicitly publish a draft/WIP PR with --draft or --wip.",
  ].join("\n"))
}

export const repoPolicyCommand = async (app: AppCfg, args: string[]) => {
  const target = await resolveRepoPublishTarget(app, repoPublishOpts(app, args))
  printRepoPublishResult(publishPolicySummary(target))
}

export const repoPublishCommand = async (app: AppCfg, kind: string, args: string[]) => {
  const opts = repoPublishOpts(app, args)
  const target = await resolveRepoPublishTarget(app, opts)
  assertAppConfigValid(app, {capability: "repo-publish", agentId: target.agent.configId})
  const repoAddr = repoAddrForPublishTarget(target)
  const tags = extraTags(args)
  const content = await readTextArg(args, "--content")

  if (kind === "raw") {
    const file = must(value(args, "--event"), "--event")
    const raw = file === "-" ? await readStdin() : await readFile(file, "utf8")
    printRepoPublishResult(await publishRepoEvent(app, parseRawRepoEvent(raw), opts))
    return
  }

  if (kind === "issue") {
    printRepoPublishResult(await publishRepoEvent(app, buildIssueEvent({
      repoAddr,
      subject: must(value(args, "--subject"), "--subject"),
      content,
      labels: values(args, "--label"),
      recipients: values(args, "--p"),
      tags,
    }), opts))
    return
  }

  if (kind === "comment") {
    printRepoPublishResult(await publishRepoEvent(app, buildCommentEvent({
      repoAddr,
      content: must(content, "--content"),
      rootId: must(value(args, "--root-id"), "--root-id"),
      rootKind: must(value(args, "--root-kind"), "--root-kind"),
      rootPubkey: value(args, "--root-pubkey") || undefined,
      rootRelay: value(args, "--root-relay") || undefined,
      parentId: value(args, "--parent-id") || undefined,
      parentKind: value(args, "--parent-kind") || undefined,
      parentPubkey: value(args, "--parent-pubkey") || undefined,
      parentRelay: value(args, "--parent-relay") || undefined,
      tags,
    }), opts))
    return
  }

  if (kind === "label") {
    const labels = values(args, "--label")
    if (labels.length === 0) throw new Error("missing --label")
    printRepoPublishResult(await publishRepoEvent(app, buildLabelEvent({
      repoAddr,
      targetId: value(args, "--target-id") || undefined,
      labels,
      namespace: value(args, "--namespace") || undefined,
      delete: flag(args, "--delete"),
      pubkeys: values(args, "--p"),
      tags,
      content,
    }), opts))
    return
  }

  if (kind === "role-label") {
    const pubkeys = values(args, "--p")
    if (pubkeys.length === 0) throw new Error("missing --p")
    printRepoPublishResult(await publishRepoEvent(app, buildRoleLabelEvent({
      repoAddr,
      rootId: must(value(args, "--target-id"), "--target-id"),
      role: must(value(args, "--role"), "--role"),
      pubkeys,
      namespace: value(args, "--namespace") || undefined,
      content,
    }), opts))
    return
  }

  if (kind === "status") {
    const state = must(value(args, "--state"), "--state")
    printRepoPublishResult(await publishRepoEvent(app, buildStatusEvent({
      repoAddr,
      state: /^\d+$/.test(state) ? Number(state) : state as "open" | "applied" | "closed" | "draft",
      rootId: must(value(args, "--root-id"), "--root-id"),
      content,
      replyId: value(args, "--reply-id") || undefined,
      recipients: values(args, "--p"),
      mergeCommit: value(args, "--merge-commit") || undefined,
      appliedCommits: values(args, "--applied-commit"),
      tags,
    }), opts))
    return
  }

  if (kind === "pr") {
    const publicationPolicy = await assertPullRequestPublicationAllowed(target, args, opts.dryRun)
    const recipients = pullRequestRecipients(target, args)
    const clone = pullRequestCloneUrls(target, args)
    const result = await publishRepoEvent(app, buildPullRequestEvent({
      repoAddr,
      subject: value(args, "--subject") || undefined,
      content,
      labels: unique([
        ...values(args, "--label"),
        ...draftLabels(args),
      ]),
      recipients,
      tipCommitOid: must(value(args, "--tip"), "--tip"),
      clone,
      targetBranch: pullRequestTargetBranch(args),
      mergeBase: value(args, "--merge-base") || undefined,
      tags,
    }), opts)
    printRepoPublishResult({
      ...result,
      publicationPolicy,
    })
    return
  }

  if (kind === "pr-update") {
    const publicationPolicy = await assertPullRequestPublicationAllowed(target, args, opts.dryRun)
    const recipients = pullRequestRecipients(target, args)
    const clone = pullRequestCloneUrls(target, args)
    const result = await publishRepoEvent(app, buildPullRequestUpdateEvent({
      repoAddr,
      pullRequestEventId: must(value(args, "--pr-id"), "--pr-id"),
      pullRequestAuthorPubkey: must(value(args, "--pr-author"), "--pr-author"),
      recipients,
      tipCommitOid: must(value(args, "--tip"), "--tip"),
      clone,
      mergeBase: value(args, "--merge-base") || undefined,
      tags: [...tags, ...draftTagExtras(args)],
    }), opts)
    printRepoPublishResult({
      ...result,
      publicationPolicy,
    })
    return
  }

  throw new Error(`unknown repo publish helper: ${kind}`)
}
