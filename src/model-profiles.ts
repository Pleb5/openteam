import type {
  AppCfg,
  ModelProfileCfg,
  PreparedAgent,
  ResolvedModelSelection,
  ResolvedModelSelectionSource,
  TaskItem,
  WorkerProfileCfg,
} from "./types.js"

const clean = (value?: string) => value?.trim() || undefined
const modelPattern = /^[A-Za-z0-9._-]+\/[^\s/][^\s]*$/
const variantPattern = /^[A-Za-z0-9._-]+$/

export type ModelSelectionValidationIssue = {
  severity: "error" | "warning"
  code: string
  message: string
}

const issue = (
  severity: ModelSelectionValidationIssue["severity"],
  code: string,
  message: string,
): ModelSelectionValidationIssue => ({severity, code, message})

export const isModelReferenceFormatValid = (value: string) => modelPattern.test(value.trim())
export const isModelVariantFormatValid = (value: string) => variantPattern.test(value.trim())

export const requireExplicitModel = (app: AppCfg) => app.config.opencode.requireExplicitModel !== false

type ResolvedWorkerProfile = {
  id?: string
  profile?: WorkerProfileCfg
  explicit: boolean
}

const modelProfiles = (app: AppCfg) => app.config.modelProfiles ?? {}
const workerProfiles = (app: AppCfg) => app.config.workerProfiles ?? {}

const requireModelProfile = (app: AppCfg, id: string, owner: string): ModelProfileCfg => {
  const profile = modelProfiles(app)[id]
  if (!profile) {
    throw new Error(`${owner} references unknown model profile '${id}'`)
  }
  if (!clean(profile.model)) {
    throw new Error(`model profile '${id}' has an empty model`)
  }
  return profile
}

export const resolveWorkerProfile = (agent: PreparedAgent): ResolvedWorkerProfile => {
  const profiles = workerProfiles(agent.app)
  const explicit = clean(agent.agent.workerProfile)
  if (explicit) {
    const profile = profiles[explicit]
    if (!profile) {
      throw new Error(`agent '${agent.configId}' references unknown worker profile '${explicit}'`)
    }
    return {id: explicit, profile, explicit: true}
  }

  const role = clean(agent.agent.role)
  if (role && profiles[role]) {
    return {id: role, profile: profiles[role], explicit: false}
  }

  return {explicit: false}
}

const fromProfile = (
  app: AppCfg,
  id: string,
  owner: string,
  source: ResolvedModelSelectionSource,
  workerProfile?: string,
): ResolvedModelSelection => {
  const profile = requireModelProfile(app, id, owner)
  return {
    model: clean(profile.model),
    variant: clean(profile.variant),
    modelProfile: id,
    workerProfile,
    source,
  }
}

const withExplicitVariant = (
  selection: ResolvedModelSelection,
  variant?: string,
): ResolvedModelSelection => variant ? {...selection, variant} : selection

export const resolveModelSelection = (
  agent: PreparedAgent,
  item: Pick<TaskItem, "model" | "modelProfile" | "modelVariant"> = {},
): ResolvedModelSelection => {
  const app = agent.app
  const taskModel = clean(item.model)
  const taskModelProfile = clean(item.modelProfile)
  const taskVariant = clean(item.modelVariant)
  const worker = resolveWorkerProfile(agent)

  if (taskModel) {
    return {
      model: taskModel,
      variant: taskVariant,
      workerProfile: worker.id,
      source: "task-model",
    }
  }

  if (taskModelProfile) {
    return withExplicitVariant(
      fromProfile(app, taskModelProfile, "task", "task-model-profile", worker.id),
      taskVariant,
    )
  }

  const agentModelProfile = clean(agent.agent.modelProfile)
  if (agentModelProfile) {
    return withExplicitVariant(
      fromProfile(app, agentModelProfile, `agent '${agent.configId}'`, "agent-model-profile", worker.id),
      taskVariant,
    )
  }

  const workerModelProfile = clean(worker.profile?.modelProfile)
  if (workerModelProfile) {
    return withExplicitVariant(
      fromProfile(
        app,
        workerModelProfile,
        worker.id ? `worker profile '${worker.id}'` : "worker profile",
        worker.explicit ? "worker-profile" : "role-default-worker-profile",
        worker.id,
      ),
      taskVariant,
    )
  }

  const role = clean(agent.agent.role)
  const roleProfile = role ? workerProfiles(app)[role] : undefined
  const roleModelProfile = clean(roleProfile?.modelProfile)
  if (roleModelProfile && worker.id !== role) {
    return withExplicitVariant(
      fromProfile(app, roleModelProfile, `role default worker profile '${role}'`, "role-default-worker-profile", worker.id),
      taskVariant,
    )
  }

  const appModelProfile = clean(app.config.opencode.modelProfile)
  if (appModelProfile) {
    return withExplicitVariant(
      fromProfile(app, appModelProfile, "opencode.modelProfile", "opencode-model-profile", worker.id),
      taskVariant,
    )
  }

  const fallback = clean(app.config.opencode.model)
  if (fallback) {
    return {
      model: fallback,
      variant: taskVariant,
      workerProfile: worker.id,
      source: "opencode-model",
    }
  }

  return {
    variant: taskVariant,
    workerProfile: worker.id,
    source: "unset",
  }
}

export const validateModelSelection = (
  app: AppCfg,
  selection: ResolvedModelSelection,
  options: {context?: string} = {},
) => {
  const context = options.context ?? "opencode model"
  const issues: ModelSelectionValidationIssue[] = []
  const model = clean(selection.model)
  const variant = clean(selection.variant)

  if (!model) {
    if (requireExplicitModel(app)) {
      issues.push(issue(
        "error",
        "model-required",
        `${context} did not resolve to an explicit model; configure modelProfiles/workerProfiles, opencode.model, or pass --model/--model-profile`,
      ))
    } else {
      issues.push(issue(
        "warning",
        "model-unset",
        `${context} is unset; openteam will rely on opencode's ambient default model`,
      ))
    }
  } else if (!isModelReferenceFormatValid(model)) {
    issues.push(issue(
      "error",
      "model-format-invalid",
      `${context} '${model}' must use opencode's provider/model format`,
    ))
  }

  if (variant && !isModelVariantFormatValid(variant)) {
    issues.push(issue(
      "error",
      "model-variant-invalid",
      `${context} variant '${variant}' must be a simple opencode variant id such as medium, high, max, or xhigh`,
    ))
  }

  return issues
}

export const assertModelSelectionValid = (
  app: AppCfg,
  selection: ResolvedModelSelection,
  options: {context?: string} = {},
) => {
  const errors = validateModelSelection(app, selection, options).filter(item => item.severity === "error")
  if (errors.length > 0) {
    throw new Error(errors.map(item => item.message).join("; "))
  }
}

export const workerProfilePromptLines = (agent: PreparedAgent) => {
  const {id, profile} = resolveWorkerProfile(agent)
  if (!id || !profile) return []

  const lines = [`Worker profile: ${id}.`]
  const policies = [
    profile.canEdit === false ? "do not edit product source files" : "",
    profile.canPublishPr === false ? "do not publish PRs" : "",
    profile.canUseBrowser === false ? "do not use browser/runtime workflows unless explicitly instructed by openteam" : "",
    profile.canSpawnSubagents === false ? "do not spawn opencode helper subagents" : "",
    profile.requiresEvidence ? "structured verification evidence is required" : "",
  ].filter(Boolean)

  if (policies.length > 0) {
    lines.push(`Worker profile policy: ${policies.join("; ")}.`)
  }

  return lines
}

export const canUseOpencodeHelperAgents = (agent: PreparedAgent) =>
  resolveWorkerProfile(agent).profile?.canSpawnSubagents !== false
