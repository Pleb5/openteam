import {existsSync} from "node:fs"
import {nip19} from "nostr-tools"
import {effectiveVerificationConfig} from "./verification.js"
import type {AgentCfg, AppCfg, ProviderCfg, TaskMode} from "./types.js"

export type ConfigValidationCapability =
  | "doctor"
  | "launch"
  | "serve"
  | "relay-sync"
  | "profile-sync"
  | "repo-publish"

export type ConfigValidationIssue = {
  severity: "error" | "warning"
  code: string
  message: string
}

export type ConfigValidationOptions = {
  capability?: ConfigValidationCapability
  agentId?: string
  mode?: TaskMode
}

const issue = (severity: ConfigValidationIssue["severity"], code: string, message: string): ConfigValidationIssue => ({
  severity,
  code,
  message,
})

const unique = (items: string[]) => Array.from(new Set(items.filter(Boolean)))

const isRelayLikeUrl = (value: string) => {
  try {
    const url = new URL(value)
    return ["ws:", "wss:", "http:", "https:"].includes(url.protocol)
  } catch {
    return false
  }
}

const providerHost = (value: string) => {
  if (!value.trim()) return ""
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`)
    return url.host
  } catch {
    return ""
  }
}

const nonEmpty = (value?: string) => Boolean(value?.trim())

const decodeNpubMaybe = (value: string) => {
  if (!value.trim()) return true
  try {
    return nip19.decode(value).type === "npub"
  } catch {
    return false
  }
}

const agentLabel = (id: string, agent?: AgentCfg) => `${id}${agent?.role ? ` (${agent.role})` : ""}`

const configuredProviderTokens = (providers: Record<string, ProviderCfg>) =>
  Object.values(providers).filter(provider => provider.host && provider.token)

const configuredForkProviderTokens = (providers: Record<string, ProviderCfg>) =>
  configuredProviderTokens(providers).filter(provider => {
    if (provider.type === "github" || provider.type === "gitlab") return true
    const host = providerHost(provider.host).toLowerCase()
    return host === "github.com" || host === "gitlab.com" || host.includes("gitlab")
  })

const repoPathIssues = (app: AppCfg) => {
  const issues: ConfigValidationIssue[] = []
  for (const [name, repo] of Object.entries(app.config.repos)) {
    if (!repo.root) {
      issues.push(issue("warning", "repo-root-empty", `repo '${name}' has an empty root path`))
      continue
    }

    if (!existsSync(repo.root)) {
      issues.push(issue("warning", "repo-root-missing", `repo '${name}' root does not exist: ${repo.root}`))
    }
  }
  return issues
}

const relayBucketIssues = (app: AppCfg) => {
  const buckets: Array<[string, string[]]> = [
    ["reporting.dmRelays", app.config.reporting.dmRelays],
    ["reporting.outboxRelays", app.config.reporting.outboxRelays],
    ["reporting.relayListBootstrapRelays", app.config.reporting.relayListBootstrapRelays],
    ["reporting.appDataRelays", app.config.reporting.appDataRelays],
    ["reporting.signerRelays", app.config.reporting.signerRelays],
    ["nostr_git.gitDataRelays", app.config.nostr_git.gitDataRelays],
    ["nostr_git.repoAnnouncementRelays", app.config.nostr_git.repoAnnouncementRelays],
    ["nostr_git.graspServers", app.config.nostr_git.graspServers],
  ]

  const issues: ConfigValidationIssue[] = []
  for (const [name, values] of buckets) {
    for (const value of values ?? []) {
      if (!isRelayLikeUrl(value)) {
        issues.push(issue("error", "invalid-relay-url", `${name} contains an invalid relay-like URL: ${value}`))
      }
    }
  }
  return issues
}

const profileIssues = (app: AppCfg) => {
  const issues: ConfigValidationIssue[] = []
  const modelProfiles = app.config.modelProfiles ?? {}
  const workerProfiles = app.config.workerProfiles ?? {}

  const knownModelProfile = (id: string) => Boolean(modelProfiles[id])

  for (const [id, profile] of Object.entries(modelProfiles)) {
    if (typeof profile.model !== "string" || !profile.model.trim()) {
      issues.push(issue("error", "model-profile-model-empty", `model profile '${id}' has an empty model`))
    }
    if (profile.variant !== undefined && (typeof profile.variant !== "string" || !profile.variant.trim())) {
      issues.push(issue("warning", "model-profile-variant-empty", `model profile '${id}' has an empty variant`))
    }
  }

  if (app.config.opencode.modelProfile && !knownModelProfile(app.config.opencode.modelProfile)) {
    issues.push(issue("error", "unknown-model-profile", `opencode.modelProfile references unknown model profile '${app.config.opencode.modelProfile}'`))
  }

  for (const [id, profile] of Object.entries(workerProfiles)) {
    if (profile.modelProfile && !knownModelProfile(profile.modelProfile)) {
      issues.push(issue("error", "unknown-model-profile", `worker profile '${id}' references unknown model profile '${profile.modelProfile}'`))
    }
    if (profile.opencodeAgent !== undefined && (typeof profile.opencodeAgent !== "string" || !profile.opencodeAgent.trim())) {
      issues.push(issue("error", "worker-profile-opencode-agent-empty", `worker profile '${id}' has an empty opencodeAgent`))
    }
    for (const key of ["canEdit", "canPublishPr", "canUseBrowser", "canSpawnSubagents", "requiresEvidence"] as const) {
      if (profile[key] !== undefined && typeof profile[key] !== "boolean") {
        issues.push(issue("error", "worker-profile-capability-invalid", `worker profile '${id}' has non-boolean ${key}`))
      }
    }
  }

  if (app.config.opencode.roleAgents !== undefined && typeof app.config.opencode.roleAgents !== "boolean") {
    issues.push(issue("error", "opencode-role-agents-invalid", "opencode.roleAgents must be boolean"))
  }

  for (const [id, agent] of Object.entries(app.config.agents)) {
    const label = agentLabel(id, agent)
    if (agent.workerProfile && !workerProfiles[agent.workerProfile]) {
      issues.push(issue("error", "unknown-worker-profile", `${label} references unknown worker profile '${agent.workerProfile}'`))
    }
    if (agent.modelProfile && !knownModelProfile(agent.modelProfile)) {
      issues.push(issue("error", "unknown-model-profile", `${label} references unknown model profile '${agent.modelProfile}'`))
    }
    if (agent.opencodeAgent !== undefined && (typeof agent.opencodeAgent !== "string" || !agent.opencodeAgent.trim())) {
      issues.push(issue("error", "agent-opencode-agent-empty", `${label} has an empty opencodeAgent`))
    }
  }

  return issues
}

const identityIssues = (app: AppCfg, options: ConfigValidationOptions) => {
  const issues: ConfigValidationIssue[] = []
  const ids = options.agentId
    ? [options.agentId]
    : Object.keys(app.config.agents)

  for (const id of ids) {
    const agent = app.config.agents[id]
    if (!agent) {
      issues.push(issue("error", "unknown-agent", `unknown agent: ${id}`))
      continue
    }

    const label = agentLabel(id, agent)
    if (agent.identity.npub && !decodeNpubMaybe(agent.identity.npub)) {
      issues.push(issue("error", "invalid-agent-npub", `${label} has an invalid identity.npub`))
    }

    const requiresSecret =
      options.capability === "launch" ||
      options.capability === "serve" ||
      options.capability === "relay-sync" ||
      options.capability === "profile-sync" ||
      options.capability === "repo-publish" ||
      agent.role === "orchestrator"

    if (requiresSecret && !nonEmpty(agent.identity.sec)) {
      issues.push(issue("error", "missing-agent-secret", `${label} is missing identity.sec`))
    } else if (!nonEmpty(agent.identity.sec)) {
      issues.push(issue("warning", "missing-agent-secret", `${label} is missing identity.sec; signing, bunker, and publishing will be unavailable`))
    }

    if (agent.repo && !app.config.repos[agent.repo]) {
      issues.push(issue("error", "unknown-agent-repo", `${label} references unknown repo config '${agent.repo}'`))
    }
  }

  return issues
}

const npubListIssues = (app: AppCfg) => {
  const values = [
    ...app.config.reporting.allowFrom.map(value => ["reporting.allowFrom", value] as const),
    ...app.config.reporting.reportTo.map(value => ["reporting.reportTo", value] as const),
  ]
  return values
    .filter(([, value]) => value && !decodeNpubMaybe(value))
    .map(([name, value]) => issue("error", "invalid-npub", `${name} contains an invalid npub: ${value}`))
}

const providerIssues = (app: AppCfg) => {
  const issues: ConfigValidationIssue[] = []
  for (const [name, provider] of Object.entries(app.config.providers)) {
    if (!provider.host) {
      issues.push(issue("warning", "provider-host-missing", `provider '${name}' has no host`))
      continue
    }
    if (!providerHost(provider.host)) {
      issues.push(issue("error", "provider-host-invalid", `provider '${name}' has an invalid host: ${provider.host}`))
    }
    if (!provider.token) {
      issues.push(issue("warning", "provider-token-missing", `provider '${name}' has no resolved token`))
    }
    if (provider.type && !["github", "gitlab", "generic"].includes(provider.type)) {
      issues.push(issue("error", "provider-type-invalid", `provider '${name}' has invalid type '${provider.type}'`))
    }
  }
  return issues
}

const forkIssues = (app: AppCfg, options: ConfigValidationOptions) => {
  const issues: ConfigValidationIssue[] = []
  const git = app.config.nostr_git
  const forkProviders = configuredForkProviderTokens(app.config.providers)
  const graspServers = unique(git.graspServers)

  if (git.forkCloneUrlTemplate && !/\{(owner|ownerNpub|ownerPubkey|forkOwner)\}/.test(git.forkCloneUrlTemplate)) {
    issues.push(issue("warning", "fork-template-owner-missing", "nostr_git.forkCloneUrlTemplate does not reference an orchestrator owner variable"))
  }
  if (git.forkCloneUrlTemplate && !/\{(repo|forkRepo|forkIdentifier)\}/.test(git.forkCloneUrlTemplate)) {
    issues.push(issue("error", "fork-template-repo-missing", "nostr_git.forkCloneUrlTemplate must reference a fork repo variable such as {repo}"))
  }
  if (git.forkGitOwner.includes(".git")) {
    issues.push(issue("error", "fork-owner-invalid", "nostr_git.forkGitOwner must be an owner/namespace hint, not a .git clone URL"))
  }

  if ((options.capability === "launch" || options.capability === "serve") && forkProviders.length === 0 && graspServers.length === 0 && !git.forkCloneUrlTemplate.trim()) {
    issues.push(issue(
      "error",
      "fork-storage-missing",
      "no orchestrator fork storage is configured; add a GitHub/GitLab provider token, nostr_git.graspServers, or nostr_git.forkCloneUrlTemplate",
    ))
  }

  return issues
}

const capabilityIssues = (app: AppCfg, options: ConfigValidationOptions) => {
  const issues: ConfigValidationIssue[] = []
  const agent = options.agentId ? app.config.agents[options.agentId] : undefined
  const effectiveMode = options.mode ?? (agent?.repo ? app.config.repos[agent.repo]?.mode : undefined)

  if ((options.capability === "launch" || options.capability === "serve") && effectiveMode === "web") {
    if (app.config.browser.mcp.command.length === 0) {
      issues.push(issue("error", "browser-mcp-command-missing", "browser.mcp.command is required before launching web-mode work"))
    }
    if (app.config.reporting.signerRelays.length === 0 && !agent?.reporting.signerRelays?.length) {
      issues.push(issue("warning", "signer-relays-empty", "signer relays are empty; browser login through remote signer will be unavailable"))
    }
  }

  if (options.capability === "relay-sync") {
    if (app.config.reporting.outboxRelays.length === 0) {
      issues.push(issue("error", "outbox-relays-empty", "relay sync requires reporting.outboxRelays"))
    }
    if (app.config.reporting.relayListBootstrapRelays.length === 0) {
      issues.push(issue("warning", "relay-bootstrap-empty", "relay sync has no relayListBootstrapRelays for discoverability"))
    }
    if (agent?.role === "orchestrator" && app.config.reporting.dmRelays.length === 0 && !agent.reporting.dmRelays?.length) {
      issues.push(issue("error", "dm-relays-empty", "orchestrator relay sync requires DM relays"))
    }
  }

  if (options.capability === "profile-sync") {
    if (app.config.reporting.appDataRelays.length === 0 && app.config.nostr_git.gitDataRelays.length === 0) {
      issues.push(issue("error", "profile-relays-empty", "profile sync requires appDataRelays or nostr_git.gitDataRelays"))
    }
    if (configuredProviderTokens(app.config.providers).length === 0) {
      issues.push(issue("error", "provider-tokens-empty", "profile sync requires at least one resolved provider token"))
    }
  }

  if ((options.capability === "launch" || options.capability === "serve") && app.config.nostr_git.repoAnnouncementRelays.length === 0) {
    issues.push(issue("warning", "repo-announcement-relays-empty", "nostr_git.repoAnnouncementRelays is empty; target resolution depends on explicit target relay hints or cached announcements"))
  }

  if (options.capability === "repo-publish" && app.config.nostr_git.repoAnnouncementRelays.length === 0) {
    issues.push(issue("warning", "repo-announcement-relays-empty", "repo publish without a context may need nostr_git.repoAnnouncementRelays to resolve the target"))
  }

  return issues
}

const verificationIssues = (app: AppCfg) => {
  const issues: ConfigValidationIssue[] = []
  const config = effectiveVerificationConfig(app)
  const validKinds = new Set(["command", "playwright-mcp", "desktop-command", "android-adb", "ios-simulator"])
  const validModes = new Set(["code", "web"])

  if (config.autoRunAfterWorker !== undefined && typeof config.autoRunAfterWorker !== "boolean") {
    issues.push(issue("error", "verification-auto-run-invalid", "verification.autoRunAfterWorker must be boolean"))
  }

  for (const [mode, runnerIds] of Object.entries(config.defaultRunners)) {
    if (!validModes.has(mode)) {
      issues.push(issue("error", "verification-default-mode-invalid", `verification.defaultRunners contains invalid mode '${mode}'`))
    }
    for (const id of runnerIds ?? []) {
      if (!config.runners[id]) {
        issues.push(issue("error", "verification-runner-missing", `verification.defaultRunners.${mode} references unknown runner '${id}'`))
      }
    }
  }

  for (const [id, runner] of Object.entries(config.runners)) {
    if (!validKinds.has(runner.kind)) {
      issues.push(issue("error", "verification-runner-kind-invalid", `verification runner '${id}' has invalid kind '${runner.kind}'`))
    }
    for (const mode of runner.modes ?? []) {
      if (!validModes.has(mode)) {
        issues.push(issue("error", "verification-runner-mode-invalid", `verification runner '${id}' has invalid mode '${mode}'`))
      }
    }
    if (runner.timeoutMs !== undefined && (!Number.isFinite(runner.timeoutMs) || runner.timeoutMs <= 0)) {
      issues.push(issue("error", "verification-runner-timeout-invalid", `verification runner '${id}' has invalid timeoutMs`))
    }
    if (runner.kind === "playwright-mcp" && runner.enabled && app.config.browser.mcp.command.length === 0) {
      issues.push(issue("warning", "verification-browser-runner-unavailable", `verification runner '${id}' is enabled but browser.mcp.command is not configured`))
    }
  }

  return issues
}

export const validateAppConfig = (app: AppCfg, options: ConfigValidationOptions = {}) => {
  const issues = [
    ...relayBucketIssues(app),
    ...profileIssues(app),
    ...identityIssues(app, options),
    ...npubListIssues(app),
    ...providerIssues(app),
    ...repoPathIssues(app),
    ...forkIssues(app, options),
    ...capabilityIssues(app, options),
    ...verificationIssues(app),
  ]

  return {
    ok: issues.every(item => item.severity !== "error"),
    issues,
    errors: issues.filter(item => item.severity === "error"),
    warnings: issues.filter(item => item.severity === "warning"),
  }
}

export const formatConfigValidationIssues = (issues: ConfigValidationIssue[]) =>
  issues.map(item => `${item.severity}: ${item.code}: ${item.message}`)

export const assertAppConfigValid = (app: AppCfg, options: ConfigValidationOptions = {}) => {
  const result = validateAppConfig(app, options)
  if (result.errors.length === 0) return result

  throw new Error([
    "config validation failed",
    ...formatConfigValidationIssues(result.errors),
    ...(result.warnings.length > 0 ? ["warnings:", ...formatConfigValidationIssues(result.warnings)] : []),
  ].join("\n"))
}
