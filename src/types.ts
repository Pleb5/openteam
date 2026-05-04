export type Dict = Record<string, string>

export type TaskMode = "web" | "code"

export type ProviderCfg = {
  host: string
  token: string
  username?: string
  type?: "github" | "gitlab" | "generic"
  apiBaseUrl?: string
  namespace?: string
  namespaceId?: string | number
  namespacePath?: string
  private?: boolean
  visibility?: "public" | "private" | "internal"
}

export type RepoCfg = {
  root: string
  baseBranch: string
  devCommand?: string[]
  healthUrl?: string
  sharedPaths: string[]
  mode?: TaskMode
}

export type McpCfg = {
  name: string
  command: string[]
  environment: Dict
}

export type BrowserCfg = {
  headless: boolean
  mcp: McpCfg
  executablePath?: string
  agentBrowserTools?: {
    enabled?: boolean
    command?: string
    allowedDomains?: string[]
    environment?: Dict
    maxOutputChars?: number
  }
}

export type VerificationRunnerKind = "command" | "playwright-mcp" | "browser-cli" | "desktop-command" | "android-adb" | "ios-simulator"
export type VerificationRunnerState = "succeeded" | "failed" | "skipped" | "blocked"
export type VerificationEvidenceType = "repo-native" | "browser" | "nostr" | "desktop" | "mobile" | "manual" | "runtime"

export type VerificationRunnerCfg = {
  kind: VerificationRunnerKind
  enabled: boolean
  local?: boolean
  description?: string
  command?: string[]
  environment?: Dict
  timeoutMs?: number
  modes?: TaskMode[]
  stacks?: string[]
  artifactsDir?: string
}

export type VerificationCfg = {
  autoRunAfterWorker?: boolean
  defaultRunners: Partial<Record<TaskMode, string[]>>
  runners: Record<string, VerificationRunnerCfg>
}

export type VerificationRunnerPlan = {
  id: string
  kind: VerificationRunnerKind
  enabled: boolean
  configured: boolean
  local: boolean
  description?: string
  reason?: string
  command?: string[]
  environment?: Dict
  timeoutMs?: number
  modes: TaskMode[]
  stacks: string[]
  artifactsDir?: string
}

export type VerificationPlan = {
  version: 1
  mode: TaskMode
  profileStacks: string[]
  selectedRunnerIds: string[]
  runners: VerificationRunnerPlan[]
}

export type DoneContract = {
  version: 1
  role: string
  mode: TaskMode
  taskClass: "bug-fix" | "ui-web" | "triage" | "qa" | "research" | "implementation" | "general"
  summary: string
  requiredEvidence: string[]
  successPolicy: string[]
  prPolicy: string
}

export type VerificationRunnerResult = {
  id: string
  kind: VerificationRunnerKind
  state: VerificationRunnerState
  evidenceType?: VerificationEvidenceType
  source?: "worker" | "runtime" | "operator"
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  command?: string[]
  cwd?: string
  logFile?: string
  artifacts?: string[]
  screenshots?: string[]
  url?: string
  flow?: string
  consoleSummary?: string
  networkSummary?: string
  eventIds?: string[]
  urlHealth?: {
    ok: boolean
    url?: string
    status?: number
    method?: string
    error?: string
    checkedAt: string
  }
  exitCode?: number
  signal?: string
  error?: string
  blocker?: string
  skippedReason?: string
  note?: string
}

export type OperatorPreviewState = "starting" | "live" | "stopped" | "failed"

export type OperatorPreviewKind = "live-run" | "local-dev-server"

export type OperatorPreviewRecord = {
  version: 1
  id: string
  kind: OperatorPreviewKind
  state: OperatorPreviewState
  requestedAt: string
  startedAt?: string
  stoppedAt?: string
  failedAt?: string
  runId: string
  checkout?: string
  contextId?: string
  contextHeld?: boolean
  url?: string
  pid?: number
  processGroup?: boolean
  logFile?: string
  command?: string[]
  health?: {
    ok: boolean
    url?: string
    status?: number
    method?: string
    error?: string
    checkedAt: string
  }
  source?: "operator"
  error?: string
}

export type ReportingCfg = {
  dmRelays: string[]
  outboxRelays: string[]
  relayListBootstrapRelays: string[]
  appDataRelays: string[]
  signerRelays: string[]
  allowFrom: string[]
  reportTo: string[]
  pollIntervalMs?: number
  dmObservationMode?: "terminal" | "digest" | "verbose"
  dmDigestIntervalMs?: number
  dmWarningThrottleMs?: number
}

export type AgentIdentityCfg = {
  npub: string
  sec: string
  bunkerProfile: string
  nakClientKey: string
}

export type AgentReportingCfg = {
  dmRelays?: string[]
  outboxRelays?: string[]
  relayListBootstrapRelays?: string[]
  appDataRelays?: string[]
  signerRelays?: string[]
  reportTo?: string[]
  allowFrom?: string[]
  pollIntervalMs?: number
}

export type NostrGitCfg = {
  graspServers: string[]
  gitDataRelays: string[]
  repoAnnouncementRelays: string[]
  forkGitOwner: string
  forkRepoPrefix: string
  forkCloneUrlTemplate: string
}

export type ModelProfileCfg = {
  model: string
  variant?: string
  description?: string
}

export type WorkerProfileCfg = {
  description?: string
  modelProfile?: string
  opencodeAgent?: string
  canEdit?: boolean
  canPublishPr?: boolean
  canUseBrowser?: boolean
  canSpawnSubagents?: boolean
  requiresEvidence?: boolean
}

export type AgentCfg = {
  role: string
  soul: string
  repo: string
  workerProfile?: string
  modelProfile?: string
  opencodeAgent?: string
  portStart: number
  reporting: AgentReportingCfg
  identity: AgentIdentityCfg
  nostr_git?: Partial<NostrGitCfg>
}

export type AgentMeta = {
  id: string
  role: string
  soul: string
  repo: string
  description: string
  capabilities: string[]
}

export type OpenCodeCfg = {
  binary: string
  model: string
  agent: string
  modelProfile?: string
  roleAgents?: boolean
  requireExplicitModel?: boolean
}

export type RootCfg = {
  runtimeRoot: string
  opencode: OpenCodeCfg
  browser: BrowserCfg
  verification?: VerificationCfg
  providers: Record<string, ProviderCfg>
  repos: Record<string, RepoCfg>
  reporting: ReportingCfg
  nostr_git: NostrGitCfg
  modelProfiles?: Record<string, ModelProfileCfg>
  workerProfiles?: Record<string, WorkerProfileCfg>
  agents: Record<string, AgentCfg>
}

export type AppCfg = {
  root: string
  config: RootCfg
}

export type TaskState = "queued" | "running" | "succeeded" | "needs-review" | "failed" | "interrupted" | "stale"

export type TaskContinuationKind = "continue" | "repair-evidence" | "retry"

export type TaskContinuation = {
  version: 1
  kind: TaskContinuationKind
  fromRunId: string
  fromRunFile?: string
  contextId: string
  checkout?: string
  branch?: string
  priorState: TaskState
  workerState?: TaskState
  verificationState?: TaskState
  failureCategory?: string
  evidenceLevel?: string
  prEligible?: boolean
  recommendedAction?: string
  missingEvidence: string[]
  prBlockers: string[]
  carryEvidence: boolean
  evidenceResults: VerificationRunnerResult[]
  subject?: ResolvedTaskSubject
  createdAt: string
}

export type TaskSource = {
  kind: "dm" | "local" | "repo-event"
  eventId?: string
  from?: string
}

export type TaskSubject = {
  kind: "repo-pr-event"
  eventId: string
  repoTarget?: string
  path?: string
}

export type TaskItem = {
  id: string
  task: string
  createdAt: string
  state: TaskState
  agentId: string
  runtimeId?: string
  target?: string
  mode?: TaskMode
  model?: string
  modelProfile?: string
  modelVariant?: string
  parallel?: boolean
  recipients?: string[]
  continuation?: TaskContinuation
  source?: TaskSource
  subject?: TaskSubject
}

export type ResolvedModelSelectionSource =
  | "task-model"
  | "task-model-profile"
  | "agent-model-profile"
  | "worker-profile"
  | "role-default-worker-profile"
  | "opencode-model-profile"
  | "opencode-model"
  | "unset"

export type ResolvedModelSelection = {
  model?: string
  variant?: string
  modelProfile?: string
  workerProfile?: string
  source: ResolvedModelSelectionSource
}

export type FinalResponseRecord = {
  text: string
  source: "opencode-output-tail" | "operator-file"
  capturedAt: string
  truncated: boolean
  chars: number
  logFile?: string
}

export type AgentPaths = {
  root: string
  workspace: string
  memory: string
  tasks: string
  queue: string
  history: string
  artifacts: string
  browser: string
  stateFile: string
}

export type RunPhaseState = "running" | "succeeded" | "failed" | "skipped" | "interrupted" | "stale"

export type ProvisionState = "pending" | "current" | "running" | "succeeded" | "failed"

export type ProvisionFailureCategory =
  | "provision-failed"
  | "provision-worker-control"
  | "project-profile-blocker"
  | "verification-tooling-missing"
  | "dev-env-wrapper-failed"
  | "provision-stale-no-process"

export type TaskRunPhase = {
  name: string
  state: RunPhaseState
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  details?: Record<string, unknown>
  error?: string
}

export type RepoIdentity = {
  key: string
  ownerPubkey: string
  ownerNpub: string
  identifier: string
  announcementEventId: string
  announcedAt: number
  relays: string[]
  cloneUrls: string[]
  name?: string
  defaultBranch?: string
  sourceHint?: string
  rawTags: string[][]
}

export type WorkerLease = {
  workerId: string
  baseAgentId?: string
  role: string
  jobId: string
  mode: TaskMode
  parallel?: boolean
  leasedAt: string
}

export type RepoContextState = "idle" | "leased"

export type RepoContext = {
  id: string
  repoKey: string
  upstreamRepoKey?: string
  path: string
  checkout: string
  mirror: string
  mode: TaskMode
  baseRef: string
  baseCommit: string
  branch: string
  state: RepoContextState
  lease?: WorkerLease
  createdAt: string
  updatedAt: string
}

export type RepoFork = {
  upstreamKey: string
  forkKey: string
  ownerPubkey: string
  ownerNpub: string
  forkIdentifier: string
  forkAnnouncementEventId: string
  upstreamCloneUrl: string
  forkCloneUrl: string
  forkCloneUrls?: string[]
  authUsername?: string
  provider: "github" | "gitlab" | "grasp" | "git-smart-http" | "announced"
  createdAt: string
  updatedAt: string
}

export type RepoRegistry = {
  version: 1
  repos: Record<string, RepoIdentity>
  contexts: Record<string, RepoContext>
  forks: Record<string, RepoFork>
}

export type ResolvedRepoTarget = {
  repo: RepoCfg
  identity: RepoIdentity
  upstreamIdentity?: RepoIdentity
  fork?: RepoFork
  context: RepoContext
  target: string
}

export type ResolvedTaskSubject = {
  kind: "repo-pr-event"
  eventId: string
  encodedEvent?: string
  repoTarget?: string
  environmentCheckout?: string
  path?: string
  checkout?: string
  repo?: {
    key: string
    ownerNpub: string
    identifier: string
  }
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

export type PreparedAgent = {
  app: AppCfg
  id: string
  configId: string
  meta: AgentMeta
  agent: AgentCfg
  repo: RepoCfg
  paths: AgentPaths
}

export type LaunchResult = {
  id: string
  state: TaskState
  workerState?: TaskState
  verificationState?: TaskState
  failureCategory?: string
  evidenceLevel?: string
  prEligible?: boolean
  recommendedAction?: string
  verificationResults?: Array<Pick<VerificationRunnerResult, "id" | "kind" | "state" | "evidenceType" | "source" | "note" | "blocker" | "error" | "logFile" | "artifacts" | "screenshots" | "url" | "flow">>
  finalResponse?: FinalResponseRecord
  task: string
  target: string
  subject?: ResolvedTaskSubject
  mode: TaskMode
  contextId?: string
  checkout?: string
  branch: string
  url: string
  logFile: string
  runId?: string
  runFile?: string
  durationMs?: number
  baseAgentId?: string
  runtimeId?: string
  parallel?: boolean
  devEnv?: string
  devEnvSource?: string
  projectProfile?: string
  projectStacks?: string[]
  verificationPlan?: string
  verificationRunners?: string[]
  taskManifest?: string
  model?: string
  modelProfile?: string
  modelVariant?: string
  workerProfile?: string
  modelSource?: ResolvedModelSelectionSource
  opencodeAgent?: string
}

export type TaskRunRecord = {
  version: 1
  runId: string
  runFile: string
  taskId: string
  agentId: string
  baseAgentId: string
  role: string
  task: string
  source?: TaskItem["source"]
  continuation?: TaskContinuation
  subject?: ResolvedTaskSubject
  model?: string
  requestedModelProfile?: string
  requestedModelVariant?: string
  resolvedModel?: string
  modelProfile?: string
  modelVariant?: string
  workerProfile?: string
  modelSource?: ResolvedModelSelectionSource
  opencodeAgent?: string
  target?: string
  mode?: TaskMode
  parallel?: boolean
  state: TaskState
  workerState?: TaskState
  verificationState?: TaskState
  failureCategory?: string
  provisionState?: ProvisionState
  provisionFailureCategory?: ProvisionFailureCategory
  projectProfilePath?: string
  taskManifestPath?: string
  verificationToolingReady?: boolean
  startedAt: string
  finishedAt?: string
  durationMs?: number
  repo?: {
    key: string
    ownerNpub: string
    identifier: string
    upstreamKey?: string
    forkProvider?: RepoFork["provider"]
    forkCloneUrl?: string
  }
  context?: {
    id: string
    checkout: string
    branch: string
    baseCommit?: string
  }
  devEnv?: {
    kind: "none" | "nix-flake" | "nix-shell"
    source?: string
    commandPrefix: string[]
  }
  projectProfile?: {
    path: string
    stacks: string[]
    docs: string[]
    likelyCommands: Array<{
      purpose: string
      command: string[]
    }>
    blockers: string[]
  }
  verification?: {
    planPath?: string
    plan: VerificationPlan
    results?: VerificationRunnerResult[]
  }
  finalResponse?: FinalResponseRecord
  doneContract?: DoneContract
  logs?: {
    opencode?: string
    opencodeAttempts?: string[]
    provision?: string
    dev?: string
  }
  process?: {
    runnerPid?: number
    provisionPid?: number
    opencodePid?: number
    devPid?: number
    bunkerPid?: number
  }
  devServer?: {
    url?: string
    pid?: number
    startedAt?: string
    stoppedAt?: string
    lastHealthOkAt?: string
    lastHealthError?: string
    lastHealthCheckAt?: string
    firstHealthFailureAt?: string
    healthChecks?: number
    healthFailures?: number
    exitCode?: number
    exitSignal?: string
    restartCount?: number
    restartAttemptedAt?: string
    restartedAt?: string
    restartLog?: string
  }
  browser?: {
    enabled: boolean
    headless: boolean
    mcpName?: string
    executablePath?: string
    profileDir: string
    artifactDir: string
    url?: string
  }
  phases: TaskRunPhase[]
  result?: LaunchResult
  error?: string
  manualTakeover?: {
    version: 1
    requestedAt: string
    releasedAt?: string
    previousState: TaskState
    reason?: string
    handoffFile?: string
    contextId?: string
    contextHeld: boolean
    stoppedManagedWorker: boolean
    releasedPriorLease?: boolean
    command: string[]
  }
  operatorPreviews?: OperatorPreviewRecord[]
}

export type AgentRuntimeState = {
  preparedAt?: string
  running?: boolean
  state?: TaskState
  taskId?: string
  task?: string
  startedAt?: string
  finishedAt?: string
  lastDmCheckAt?: number
  seenDmIds?: string[]
  seenRepoEventIds?: string[]
  lastRepoEventCheckAt?: number
  bunkerUri?: string
  bunkerPid?: number
  contextId?: string
  checkout?: string
  branch?: string
  runId?: string
  runFile?: string
  durationMs?: number
  mode?: TaskMode
  target?: string
  subject?: ResolvedTaskSubject
  baseAgentId?: string
  runtimeId?: string
  parallel?: boolean
  model?: string
  modelProfile?: string
  modelVariant?: string
  workerProfile?: string
  modelSource?: ResolvedModelSelectionSource
  opencodeAgent?: string
  url?: string
  logFile?: string
  browserProfile?: string
  browserArtifacts?: string
  browserHeadless?: boolean
  devEnv?: string
  devEnvSource?: string
  projectProfile?: string
  projectStacks?: string[]
  verificationPlan?: string
  verificationRunners?: string[]
  taskManifest?: string
}

export type InboundDm = {
  id: string
  fromHex: string
  fromNpub: string
  createdAt: number
  body: string
}
