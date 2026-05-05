import {mkdir, readFile, writeFile} from "node:fs/promises"
import path from "node:path"
import type {DevEnv} from "./dev-env.js"
import type {ProjectProfile} from "./project-profile.js"
import type {RepoRelayPolicy} from "./repo.js"
import type {
  DoneContract,
  OpenCodeRuntimeHandoff,
  PreparedAgent,
  ResolvedModelSelection,
  RepoIdentity,
  ResolvedRepoTarget,
  ResolvedTaskSubject,
  TaskItem,
  TaskMode,
  TaskRunRecord,
  VerificationPlan,
} from "./types.js"

export const taskManifestPath = (checkout: string) =>
  path.join(checkout, ".openteam", "task.json")

const repoPublishContextPath = (checkout: string) =>
  path.join(checkout, ".openteam", "repo-context.json")

const verificationResultsPath = (checkout: string) =>
  path.join(checkout, ".openteam", "verification-results.json")

const stripUrlCredentials = (value: string) => {
  try {
    const url = new URL(value)
    if (!url.username && !url.password) return value
    url.username = ""
    url.password = ""
    return url.toString()
  } catch {
    return value
  }
}

export type TaskManifestRuntime = {
  opencodeLogFile?: string
  web?: {
    url: string
    browserProfile: string
    browserArtifacts: string
    headless: boolean
    remoteSignerAvailable: boolean
  }
}

type ManifestRepoIdentity = {
  key: string
  ownerNpub: string
  identifier: string
  announcementEventId?: string
  defaultBranch?: string
  cloneUrls: string[]
}

type ManifestSubject = {
  kind: ResolvedTaskSubject["kind"]
  eventId: string
  repoTarget?: string
  path?: string
  checkout?: string
  repo?: ResolvedTaskSubject["repo"]
  relays?: string[]
  eventKind?: number
  eventAuthor?: string
  baseCommit?: string
  tipCommit?: string
  targetBranch?: string
  cloneUrls?: string[]
  fetched?: boolean
  checkedOut?: boolean
  warnings?: string[]
}

type ManifestContinuation = {
  version: 1
  kind: TaskItem["continuation"] extends infer T
    ? T extends {kind: infer K}
      ? K
      : never
    : never
  fromRunId: string
  fromRunFile?: string
  contextId: string
  checkout?: string
  branch?: string
  priorState: string
  workerState?: string
  verificationState?: string
  failureCategory?: string
  evidenceLevel?: string
  prEligible?: boolean
  recommendedAction?: string
  missingEvidence: string[]
  prBlockers: string[]
  carryEvidence: boolean
  subject?: ManifestSubject
  createdAt: string
}

export type TaskManifest = {
  version: 1
  generatedAt: string
  run: {
    runId: string
    runFile: string
    taskId: string
    agentId: string
    baseAgentId: string
    role: string
    mode: TaskMode
    model?: string
    requestedModel?: string
    requestedModelProfile?: string
    requestedModelVariant?: string
    modelProfile?: string
    modelVariant?: string
    workerProfile?: string
    modelSource?: ResolvedModelSelection["source"]
    opencodeAgent?: string
    parallel?: boolean
    source?: TaskItem["source"]
    startedAt: string
  }
  opencode?: OpenCodeRuntimeHandoff
  task: {
    text: string
    target: string
    subject?: ManifestSubject
    continuation?: ManifestContinuation
  }
  repo: {
    target: string
    contextId: string
    checkout: string
    branch: string
    baseRef?: string
    baseCommit?: string
    upstreamBaseRef?: string
    repo: ManifestRepoIdentity
    upstreamRepo?: ManifestRepoIdentity
    fork?: {
      provider: string
      forkKey: string
      forkOwnerNpub: string
      forkIdentifier: string
      forkCloneUrl: string
      forkCloneUrls?: string[]
    }
  }
  environment: {
    checkout: string
    devEnv: {
      kind: DevEnv["kind"]
      source?: string
      commandPrefix: string[]
    }
    projectProfilePath: string
    projectStacks: string[]
    projectDocs: string[]
    projectBlockers: string[]
    runtimePath: string
    scratchPath: string
    cachePath: string
    artifactsPath: string
  }
  files: {
    taskManifest: string
    runRecord: string
    repoPublishContext: string
    projectProfile: string
    verificationPlan: string
    verificationResults: string
  }
  doneContract: DoneContract
  verification: {
    planPath: string
    resultsPath: string
    plan: VerificationPlan
  }
  publication: {
    defaultScope: "repo" | "upstream"
    normalPrRequiresStrongEvidence: true
    repoRelayPolicy: RepoRelayPolicy
    helpers: {
      policy: "openteam repo policy"
      publish: "openteam repo publish <issue|comment|label|role-label|status|pr|pr-update|raw>"
    }
  }
  runtime?: TaskManifestRuntime
}

export type BuildTaskManifestInput = {
  agent: PreparedAgent
  item: TaskItem
  runRecord: Pick<TaskRunRecord, "runId" | "runFile" | "taskId" | "startedAt" | "opencodeAgent">
  resolved: ResolvedRepoTarget
  repoPolicy: RepoRelayPolicy
  defaultPublishScope: "repo" | "upstream"
  devEnv: DevEnv
  projectProfile: ProjectProfile
  projectProfileFile: string
  verificationPlan: VerificationPlan
  verificationPlanFile: string
  doneContract: DoneContract
  modelSelection?: ResolvedModelSelection
  opencodeAgent?: string
  opencodeRuntime?: OpenCodeRuntimeHandoff
  subject?: ResolvedTaskSubject
  runtime?: TaskManifestRuntime
  environmentPaths?: {
    runtime: string
    scratch: string
    cache: string
    artifacts: string
  }
}

const defaultEnvironmentPaths = (checkout: string) => {
  const runtime = path.join(path.dirname(checkout), ".openteam-runtime")
  return {
    runtime,
    scratch: path.join(runtime, "tmp"),
    cache: path.join(runtime, "cache"),
    artifacts: path.join(runtime, "artifacts"),
  }
}

const repoIdentitySummary = (identity: RepoIdentity): ManifestRepoIdentity => ({
  key: identity.key,
  ownerNpub: identity.ownerNpub,
  identifier: identity.identifier,
  announcementEventId: identity.announcementEventId,
  defaultBranch: identity.defaultBranch,
  cloneUrls: identity.cloneUrls.map(stripUrlCredentials),
})

const subjectSummary = (subject?: ResolvedTaskSubject): ManifestSubject | undefined => {
  if (!subject) return undefined
  return {
    kind: subject.kind,
    eventId: subject.eventId,
    repoTarget: subject.repoTarget,
    path: subject.path,
    checkout: subject.checkout,
    repo: subject.repo,
    relays: subject.relays,
    eventKind: subject.eventKind,
    eventAuthor: subject.eventAuthor,
    baseCommit: subject.baseCommit,
    tipCommit: subject.tipCommit,
    targetBranch: subject.targetBranch,
    cloneUrls: subject.cloneUrls?.map(stripUrlCredentials),
    fetched: subject.fetched,
    checkedOut: subject.checkedOut,
    warnings: subject.warnings,
  }
}

const continuationSummary = (continuation?: TaskItem["continuation"]): ManifestContinuation | undefined => {
  if (!continuation) return undefined
  return {
    version: continuation.version,
    kind: continuation.kind,
    fromRunId: continuation.fromRunId,
    fromRunFile: continuation.fromRunFile,
    contextId: continuation.contextId,
    checkout: continuation.checkout,
    branch: continuation.branch,
    priorState: continuation.priorState,
    workerState: continuation.workerState,
    verificationState: continuation.verificationState,
    failureCategory: continuation.failureCategory,
    evidenceLevel: continuation.evidenceLevel,
    prEligible: continuation.prEligible,
    recommendedAction: continuation.recommendedAction,
    missingEvidence: continuation.missingEvidence,
    prBlockers: continuation.prBlockers,
    carryEvidence: continuation.carryEvidence,
    subject: subjectSummary(continuation.subject),
    createdAt: continuation.createdAt,
  }
}

export const buildTaskManifest = (input: BuildTaskManifestInput): TaskManifest => {
  const checkout = input.resolved.context.checkout
  const manifestFile = taskManifestPath(checkout)
  const environmentPaths = input.environmentPaths ?? defaultEnvironmentPaths(checkout)
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    run: {
      runId: input.runRecord.runId,
      runFile: input.runRecord.runFile,
      taskId: input.runRecord.taskId,
      agentId: input.agent.id,
      baseAgentId: input.agent.configId,
      role: input.agent.agent.role,
      mode: input.resolved.context.mode,
      model: input.modelSelection?.model ?? input.item.model,
      requestedModel: input.item.model,
      requestedModelProfile: input.item.modelProfile,
      requestedModelVariant: input.item.modelVariant,
      modelProfile: input.modelSelection?.modelProfile ?? input.item.modelProfile,
      modelVariant: input.modelSelection?.variant ?? input.item.modelVariant,
      workerProfile: input.modelSelection?.workerProfile,
      modelSource: input.modelSelection?.source,
      opencodeAgent: input.opencodeAgent ?? input.runRecord.opencodeAgent,
      parallel: input.item.parallel,
      source: input.item.source,
      startedAt: input.runRecord.startedAt,
    },
    task: {
      text: input.item.task,
      target: stripUrlCredentials(input.resolved.target),
      subject: subjectSummary(input.subject),
      continuation: continuationSummary(input.item.continuation),
    },
    opencode: input.opencodeRuntime,
    repo: {
      target: stripUrlCredentials(input.resolved.target),
      contextId: input.resolved.context.id,
      checkout,
      branch: input.resolved.context.branch,
      baseRef: input.resolved.context.baseRef,
      baseCommit: input.resolved.context.baseCommit,
      upstreamBaseRef: input.resolved.upstreamIdentity ? input.resolved.context.baseRef : undefined,
      repo: repoIdentitySummary(input.resolved.identity),
      upstreamRepo: input.resolved.upstreamIdentity
        ? repoIdentitySummary(input.resolved.upstreamIdentity)
        : undefined,
      fork: input.resolved.fork
        ? {
          provider: input.resolved.fork.provider,
          forkKey: input.resolved.fork.forkKey,
          forkOwnerNpub: input.resolved.fork.ownerNpub,
          forkIdentifier: input.resolved.fork.forkIdentifier,
          forkCloneUrl: stripUrlCredentials(input.resolved.fork.forkCloneUrl),
          forkCloneUrls: input.resolved.fork.forkCloneUrls?.map(stripUrlCredentials),
        }
        : undefined,
    },
    environment: {
      checkout,
      devEnv: {
        kind: input.devEnv.kind,
        source: input.devEnv.source,
        commandPrefix: input.devEnv.commandPrefix,
      },
      projectProfilePath: input.projectProfileFile,
      projectStacks: input.projectProfile.stacks,
      projectDocs: input.projectProfile.docs,
      projectBlockers: input.projectProfile.blockers,
      runtimePath: environmentPaths.runtime,
      scratchPath: environmentPaths.scratch,
      cachePath: environmentPaths.cache,
      artifactsPath: environmentPaths.artifacts,
    },
    files: {
      taskManifest: manifestFile,
      runRecord: input.runRecord.runFile,
      repoPublishContext: repoPublishContextPath(checkout),
      projectProfile: input.projectProfileFile,
      verificationPlan: input.verificationPlanFile,
      verificationResults: verificationResultsPath(checkout),
    },
    doneContract: input.doneContract,
    verification: {
      planPath: input.verificationPlanFile,
      resultsPath: verificationResultsPath(checkout),
      plan: input.verificationPlan,
    },
    publication: {
      defaultScope: input.defaultPublishScope,
      normalPrRequiresStrongEvidence: true,
      repoRelayPolicy: input.repoPolicy,
      helpers: {
        policy: "openteam repo policy",
        publish: "openteam repo publish <issue|comment|label|role-label|status|pr|pr-update|raw>",
      },
    },
    runtime: input.runtime,
  }
}

export const writeTaskManifest = async (input: BuildTaskManifestInput) => {
  const manifest = buildTaskManifest(input)
  await mkdir(path.dirname(manifest.files.taskManifest), {recursive: true})
  await writeFile(manifest.files.taskManifest, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest.files.taskManifest
}

export const readTaskManifest = async (checkout: string) => {
  return JSON.parse(await readFile(taskManifestPath(checkout), "utf8")) as TaskManifest
}
