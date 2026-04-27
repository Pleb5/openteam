import type {TaskSource} from "./types.js"

type Env = Record<string, string | undefined>

export type TaskContext = {
  recipients?: string[]
  source?: TaskSource
}

export const TASK_RECIPIENTS_ENV = "OPENTEAM_TASK_RECIPIENTS"
export const TASK_SOURCE_KIND_ENV = "OPENTEAM_TASK_SOURCE_KIND"
export const TASK_SOURCE_EVENT_ID_ENV = "OPENTEAM_TASK_SOURCE_EVENT_ID"
export const TASK_SOURCE_FROM_ENV = "OPENTEAM_TASK_SOURCE_FROM"

export const encodeTaskContextEnv = (context: TaskContext) => {
  const env: Record<string, string> = {}
  if (context.recipients?.length) {
    env[TASK_RECIPIENTS_ENV] = JSON.stringify(Array.from(new Set(context.recipients)))
  }
  if (context.source?.kind) {
    env[TASK_SOURCE_KIND_ENV] = context.source.kind
  }
  if (context.source?.eventId) {
    env[TASK_SOURCE_EVENT_ID_ENV] = context.source.eventId
  }
  if (context.source?.from) {
    env[TASK_SOURCE_FROM_ENV] = context.source.from
  }
  return env
}

export const recipientsFromEnv = (env: Env = process.env) => {
  const raw = env[TASK_RECIPIENTS_ENV]
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === "string" && item) : []
  } catch {
    return raw.split(",").map(item => item.trim()).filter(Boolean)
  }
}

export const sourceFromEnv = (env: Env = process.env): TaskSource | undefined => {
  const kind = env[TASK_SOURCE_KIND_ENV]
  if (!kind) return undefined
  if (kind !== "dm" && kind !== "local" && kind !== "repo-event") {
    throw new Error(`invalid task source kind ${kind}`)
  }
  return {
    kind,
    eventId: env[TASK_SOURCE_EVENT_ID_ENV] || undefined,
    from: env[TASK_SOURCE_FROM_ENV] || undefined,
  }
}
