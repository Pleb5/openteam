export type Dict = Record<string, string>

export type ProviderCfg = {
  host: string
  token: string
}

export type RepoCfg = {
  root: string
  baseBranch: string
  devCommand: string[]
  healthUrl: string
  worktreeRoot: string
  sharedPaths: string[]
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
}

export type ReportingCfg = {
  allowFrom: string[]
  reportTo: string[]
  pollIntervalMs?: number
}

export type AgentIdentityCfg = {
  npub: string
  sec: string
  bunkerProfile: string
  nakClientKey: string
}

export type AgentReportingCfg = {
  dmRelays: string[]
  outboxRelays: string[]
  relayListBootstrapRelays: string[]
  appDataRelays: string[]
  signerRelays: string[]
  reportTo: string[]
  allowFrom?: string[]
  pollIntervalMs?: number
}

export type AgentCfg = {
  role: string
  soul: string
  repo: string
  portStart: number
  reporting: AgentReportingCfg
  identity: AgentIdentityCfg
  nostr_git?: {
    graspServers?: string[]
    gitDataRelays?: string[]
  }
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
}

export type RootCfg = {
  runtimeRoot: string
  opencode: OpenCodeCfg
  browser: BrowserCfg
  providers: Record<string, ProviderCfg>
  repos: Record<string, RepoCfg>
  reporting: ReportingCfg
  agents: Record<string, AgentCfg>
}

export type AppCfg = {
  root: string
  config: RootCfg
}

export type TaskState = "queued" | "running" | "succeeded" | "failed"

export type TaskItem = {
  id: string
  task: string
  createdAt: string
  state: TaskState
  agentId: string
  recipients?: string[]
  source?: {
    kind: "dm" | "local"
    eventId?: string
    from?: string
  }
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
  worktrees: string
  stateFile: string
}

export type PreparedAgent = {
  app: AppCfg
  id: string
  meta: AgentMeta
  agent: AgentCfg
  repo: RepoCfg
  paths: AgentPaths
}

export type LaunchResult = {
  id: string
  state: TaskState
  task: string
  worktree: string
  branch: string
  url: string
  logFile: string
}

export type AgentRuntimeState = {
  preparedAt?: string
  running?: boolean
  taskId?: string
  task?: string
  startedAt?: string
  finishedAt?: string
  lastDmCheckAt?: number
  seenDmIds?: string[]
  bunkerUri?: string
  bunkerPid?: number
  worktree?: string
  branch?: string
  url?: string
  logFile?: string
}

export type InboundDm = {
  id: string
  fromHex: string
  fromNpub: string
  createdAt: number
  body: string
}
