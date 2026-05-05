import {existsSync} from "node:fs"
import {mkdir, writeFile} from "node:fs/promises"
import path from "node:path"
import type {AppCfg, OpenCodeRuntimeHandoff, ResolvedModelAttempt, ResolvedModelSelection} from "./types.js"

const clean = (value?: string) => value?.trim() || undefined

export const opencodeRuntimeHandoffPath = (checkout: string) =>
  path.join(checkout, ".openteam", "opencode-runtime.json")

export const opencodeRuntimeSummaryPath = (checkout: string) =>
  path.join(checkout, ".openteam", "context", "opencode-auth.md")

export const splitOpencodeModel = (model?: string) => {
  const value = clean(model)
  if (!value) return {}
  const index = value.indexOf("/")
  if (index <= 0 || index === value.length - 1) return {modelId: value}
  return {
    provider: value.slice(0, index),
    modelId: value.slice(index + 1),
  }
}

const sourceDataDir = () =>
  clean(process.env.OPENTEAM_OPENCODE_SOURCE_DATA_DIR) ?? path.join(process.env.HOME ?? "", ".local", "share", "opencode")

const sourceStateDir = () =>
  clean(process.env.OPENTEAM_OPENCODE_SOURCE_STATE_DIR) ?? path.join(process.env.HOME ?? "", ".local", "state", "opencode")

const modelInventory = (app: AppCfg): OpenCodeRuntimeHandoff["availableModels"] => {
  const profiles: OpenCodeRuntimeHandoff["availableModels"] = Object.entries(app.config.modelProfiles ?? {}).flatMap(([profile, item]) => {
    const model = clean(item.model)
    return model ? [{model, variant: clean(item.variant), source: "modelProfile", profile}] : []
  })
  const fallback: OpenCodeRuntimeHandoff["availableModels"] = clean(app.config.opencode.model)
    ? [{model: clean(app.config.opencode.model)!, source: "opencode.model"}]
    : []
  const seen = new Set<string>()
  return [...profiles, ...fallback].filter(item => {
    const key = `${item.model}:${item.variant ?? ""}:${item.profile ?? ""}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const buildOpenCodeRuntimeHandoff = (input: {
  app: AppCfg
  checkout: string
  binary: string
  opencodeAgent: string
  modelSelection: ResolvedModelSelection
  modelAttemptPlan?: ResolvedModelAttempt[]
}): OpenCodeRuntimeHandoff => {
  const dataDir = sourceDataDir()
  const stateDir = sourceStateDir()
  const authJsonPresent = Boolean(dataDir && existsSync(path.join(dataDir, "auth.json")))
  const modelJsonPresent = Boolean(stateDir && existsSync(path.join(stateDir, "model.json")))
  const kvJsonPresent = Boolean(stateDir && existsSync(path.join(stateDir, "kv.json")))
  const model = clean(input.modelSelection.model)
  const availableModels = modelInventory(input.app)
  const selectedModelAvailable = Boolean(model && availableModels.some(item => item.model === model))
  const status: OpenCodeRuntimeHandoff["auth"]["status"] = !model
    ? "model-unset"
    : !authJsonPresent
      ? "missing-auth"
      : !modelJsonPresent
        ? "missing-model-state"
        : "ready"
  const {provider, modelId} = splitOpencodeModel(model)

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    agent: input.opencodeAgent,
    binary: input.binary,
    model,
    variant: clean(input.modelSelection.variant),
    modelProfile: input.modelSelection.modelProfile,
    modelSource: input.modelSelection.source,
    provider,
    modelId,
    selectedModelAvailable,
    availableModels,
    attemptPlan: input.modelAttemptPlan?.map(item => ({
      planIndex: item.planIndex,
      model: item.model,
      variant: item.variant,
      modelProfile: item.modelProfile,
      source: item.source,
      provider: item.provider,
      modelId: item.modelId,
      fallbackKind: item.fallbackKind,
    })),
    auth: {
      sourceDataDir: dataDir ? "(host OpenCode data dir; path withheld)" : "(unset)",
      sourceStateDir: stateDir ? "(host OpenCode state dir; path withheld)" : "(unset)",
      authJsonPresent,
      modelJsonPresent,
      kvJsonPresent,
      hydrated: authJsonPresent || modelJsonPresent || kvJsonPresent,
      status,
    },
    files: {
      json: opencodeRuntimeHandoffPath(input.checkout),
      summary: opencodeRuntimeSummaryPath(input.checkout),
    },
  }
}

const yesNo = (value: boolean) => value ? "yes" : "no"

const summaryMarkdown = (handoff: OpenCodeRuntimeHandoff) => [
  "# OpenCode Runtime Handoff",
  "",
  `- agent: ${handoff.agent}`,
  `- binary: ${handoff.binary}`,
  `- selected model: ${handoff.model ?? "(unset)"}`,
  `- selected variant: ${handoff.variant ?? "(unset)"}`,
  `- model profile: ${handoff.modelProfile ?? "(unset)"}`,
  `- model source: ${handoff.modelSource ?? "(unset)"}`,
  `- provider: ${handoff.provider ?? "(unknown)"}`,
  `- provider model id: ${handoff.modelId ?? "(unknown)"}`,
  `- selected model configured in openteam: ${yesNo(handoff.selectedModelAvailable)}`,
  `- model fallback attempts configured: ${handoff.attemptPlan?.length ?? 1}`,
  `- auth status: ${handoff.auth.status}`,
  `- auth.json source present: ${yesNo(handoff.auth.authJsonPresent)}`,
  `- model.json source present: ${yesNo(handoff.auth.modelJsonPresent)}`,
  `- kv.json source present: ${yesNo(handoff.auth.kvJsonPresent)}`,
  `- available configured models: ${handoff.availableModels.map(item => `${item.model}${item.variant ? `:${item.variant}` : ""}`).join(", ") || "none"}`,
  ...(handoff.attemptPlan && handoff.attemptPlan.length > 1
    ? handoff.attemptPlan.map(item => `- attempt ${item.planIndex + 1}: ${item.model ?? "(unset)"}${item.variant ? `:${item.variant}` : ""} (${item.fallbackKind})`)
    : []),
  "",
  "This file is sanitized. Do not inspect raw host OpenCode auth files or runtime auth state from worker tasks.",
  "",
].join("\n")

export const writeOpenCodeRuntimeHandoff = async (input: {
  app: AppCfg
  checkout: string
  binary: string
  opencodeAgent: string
  modelSelection: ResolvedModelSelection
  modelAttemptPlan?: ResolvedModelAttempt[]
}) => {
  const handoff = buildOpenCodeRuntimeHandoff(input)
  await mkdir(path.dirname(handoff.files.json), {recursive: true})
  await mkdir(path.dirname(handoff.files.summary), {recursive: true})
  await writeFile(handoff.files.json, `${JSON.stringify(handoff, null, 2)}\n`)
  await writeFile(handoff.files.summary, summaryMarkdown(handoff))
  return handoff
}
