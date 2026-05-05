import {existsSync} from "node:fs"
import path from "node:path"

export type OpenCodeRuntimeKind =
  | "tool-in-flight"
  | "model-stream-stalled"
  | "model-stream-stalled-after-tool"
  | "permission-blocked"
  | "unknown-idle"

export type OpenCodeRuntimeTool = {
  name: string
  inputPath?: string
  status?: string
}

export type OpenCodeRuntimeState = {
  kind: OpenCodeRuntimeKind
  dbPath?: string
  messageId?: string
  messageAgeMs?: number
  lastCompletedTool?: OpenCodeRuntimeTool
  activeTool?: OpenCodeRuntimeTool
  provider?: string
  model?: string
  evidence: string
}

type InspectOptions = {
  nowMs?: number
  stallThresholdMs?: number
}

type DbRow = Record<string, unknown>

const DEFAULT_STALL_THRESHOLD_MS = 10 * 60_000

const runtimeName = (value: string) =>
  value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160) || "session"

export const resolveOpenCodeDbPath = (input: {
  checkout?: string
  runId?: string
  attempt?: number
  stateDir?: string
  logFile?: string
}) => {
  if (input.stateDir) return path.join(input.stateDir, "data", "opencode", "opencode.db")
  if (input.checkout && input.runId) {
    const bulkRoot = process.env.OPENTEAM_CHECKOUT_RUNTIME_ROOT?.trim()
      || path.join(path.dirname(input.checkout), ".openteam-runtime")
    return path.join(bulkRoot, "opencode", runtimeName(input.runId), `attempt-${input.attempt ?? 1}`, "data", "opencode", "opencode.db")
  }
  const match = input.logFile?.match(/^(.*[/\\]\.openteam-runtime[/\\]opencode[/\\][^/\\]+[/\\]attempt-\d+)(?:[/\\]|$)/)
  return match ? path.join(match[1], "data", "opencode", "opencode.db") : undefined
}

const stringValue = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined

const numberValue = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
    const date = Date.parse(value)
    if (Number.isFinite(date)) return date
  }
  return undefined
}

const rowValue = (row: DbRow, names: string[]) => {
  const entries = Object.entries(row)
  for (const name of names) {
    const found = entries.find(([key]) => key.toLowerCase() === name.toLowerCase())
    if (found) return found[1]
  }
  return undefined
}

const timeMs = (value: unknown) => {
  const raw = numberValue(value)
  if (raw === undefined) return undefined
  if (raw > 1_000_000_000_000) return raw
  if (raw > 1_000_000_000) return raw * 1000
  return raw
}

const parseJson = (value: unknown) => {
  if (!value) return undefined
  if (typeof value === "object") return value as Record<string, unknown>
  if (typeof value !== "string") return undefined
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

const getNested = (value: unknown, pathNames: string[]) => {
  let current = value
  for (const name of pathNames) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[name]
  }
  return current
}

const payloadType = (row: DbRow, data?: Record<string, unknown>) =>
  stringValue(rowValue(row, ["type", "part_type", "partType"]))
  ?? stringValue(data?.type)
  ?? stringValue(data?.kind)

const toolName = (row: DbRow, data?: Record<string, unknown>) =>
  stringValue(rowValue(row, ["tool", "tool_name", "toolName", "name"]))
  ?? stringValue(data?.tool)
  ?? stringValue(data?.toolName)
  ?? stringValue(data?.name)
  ?? stringValue(getNested(data, ["call", "tool"]))
  ?? stringValue(getNested(data, ["state", "title"]))

const toolStatus = (data?: Record<string, unknown>) =>
  stringValue(getNested(data, ["state", "status"]))
  ?? stringValue(data?.status)

const firstPathValue = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const obj = value as Record<string, unknown>
  for (const key of ["path", "file", "filePath", "filepath", "pattern"]) {
    const found = stringValue(obj[key])
    if (found) return found
  }
  for (const nested of Object.values(obj)) {
    const found = firstPathValue(nested)
    if (found) return found
  }
  return undefined
}

const inputPath = (data?: Record<string, unknown>) =>
  firstPathValue(data?.input)
  ?? firstPathValue(data?.args)
  ?? firstPathValue(getNested(data, ["call", "input"]))
  ?? firstPathValue(data)

const isToolPart = (row: DbRow, data?: Record<string, unknown>) => {
  const type = payloadType(row, data)
  return type === "tool" || type === "tool-call" || Boolean(toolName(row, data) && (data?.state || data?.input || data?.args))
}

const toolFromPart = (row: DbRow, data?: Record<string, unknown>): OpenCodeRuntimeTool => ({
  name: toolName(row, data) ?? "unknown",
  inputPath: inputPath(data),
  status: toolStatus(data),
})

const toolLabel = (tool?: OpenCodeRuntimeTool) => tool ? `${tool.name}${tool.inputPath ? ` ${tool.inputPath}` : ""}` : undefined

const evidenceFor = (state: Omit<OpenCodeRuntimeState, "evidence">) => [
  state.lastCompletedTool ? `lastCompletedTool=${toolLabel(state.lastCompletedTool)}` : undefined,
  state.activeTool ? `activeTool=${toolLabel(state.activeTool)}` : undefined,
  state.messageAgeMs !== undefined ? `messageAgeMs=${Math.round(state.messageAgeMs)}` : undefined,
  state.provider ? `provider=${state.provider}` : undefined,
  state.model ? `model=${state.model}` : undefined,
].filter(Boolean).join("; ") || "OpenCode runtime state unavailable"

const finishReason = (row: DbRow, data?: Record<string, unknown>) =>
  stringValue(rowValue(row, ["finish", "finish_reason", "finishReason"]))
  ?? stringValue(data?.finish)
  ?? stringValue(data?.finishReason)
  ?? stringValue(getNested(data, ["state", "finish"]))

const messageId = (row: DbRow) => stringValue(rowValue(row, ["id", "message_id", "messageID"]))

const messageData = (row: DbRow) => parseJson(rowValue(row, ["data", "json", "payload"]))

const messageRole = (row: DbRow, data?: Record<string, unknown>) =>
  stringValue(rowValue(row, ["role"]))
  ?? stringValue(data?.role)

const messageProvider = (row: DbRow, data?: Record<string, unknown>) =>
  stringValue(rowValue(row, ["provider", "provider_id", "providerID"]))
  ?? stringValue(data?.providerID)
  ?? stringValue(data?.provider)

const messageModel = (row: DbRow, data?: Record<string, unknown>) =>
  stringValue(rowValue(row, ["model", "model_id", "modelID"]))
  ?? stringValue(data?.modelID)
  ?? stringValue(data?.model)

const rowTime = (row: DbRow) => timeMs(rowValue(row, ["time_updated", "timeUpdated", "updated_at", "updatedAt", "time_created", "timeCreated", "created_at", "createdAt"]))

const rowCreatedTime = (row: DbRow) => timeMs(rowValue(row, ["time_created", "timeCreated", "created_at", "createdAt", "time_updated", "timeUpdated", "updated_at", "updatedAt"]))

export const inspectOpenCodeDbState = async (
  dbPath: string | undefined,
  options: InspectOptions = {},
): Promise<OpenCodeRuntimeState> => {
  if (!dbPath || !existsSync(dbPath)) return {kind: "unknown-idle", dbPath, evidence: "OpenCode database unavailable"}

  const {Database} = await import("bun:sqlite")
  const db = new Database(dbPath, {readonly: true, create: false})
  try {
    const tables = new Set(db.query<{name: string}>("select name from sqlite_master where type = 'table'").all().map(row => row.name))
    if (!tables.has("message") || !tables.has("part")) return {kind: "unknown-idle", dbPath, evidence: "OpenCode database missing message or part table"}

    const messages = db.query<DbRow>("select * from message").all()
      .sort((a, b) => (rowTime(b) ?? 0) - (rowTime(a) ?? 0))
      .slice(0, 20)
    const parsedMessages = messages.map(row => ({row, data: messageData(row)}))
    const assistantMessages = parsedMessages.filter(item => messageRole(item.row, item.data) === "assistant")
    const latest = assistantMessages[0]
    if (!latest) return {kind: "unknown-idle", dbPath, evidence: "OpenCode database has no assistant message"}

    const latestId = messageId(latest.row)
    const allParts = db.query<DbRow>("select * from part").all()
      .sort((a, b) => (rowTime(a) ?? 0) - (rowTime(b) ?? 0))
      .slice(-500)
    const partsFor = (id?: string) => allParts.filter(row => {
      const partMessageId = stringValue(rowValue(row, ["message_id", "messageID", "messageId", "message"]))
      return id && partMessageId === id
    })
    const latestParts = partsFor(latestId)
    const latestParsed = latestParts.map(row => {
      const data = parseJson(rowValue(row, ["data", "json", "payload"]))
      return {row, data, type: payloadType(row, data)}
    })
    const provider = messageProvider(latest.row, latest.data) ?? stringValue(latestParsed.map(part => part.data?.provider).find(Boolean))
    const model = messageModel(latest.row, latest.data) ?? stringValue(latestParsed.map(part => part.data?.model).find(Boolean))
    const nowMs = options.nowMs ?? Date.now()
    const created = rowCreatedTime(latest.row) ?? timeMs(getNested(latest.data, ["time", "created"]))
    const messageAgeMs = created !== undefined ? Math.max(0, nowMs - created) : undefined
    const base = {dbPath, messageId: latestId, messageAgeMs, provider, model}

    const activeToolPart = [...latestParsed].reverse().find(part => isToolPart(part.row, part.data) && toolStatus(part.data) !== "completed")
    if (activeToolPart) {
      const state = {...base, kind: "tool-in-flight" as const, activeTool: toolFromPart(activeToolPart.row, activeToolPart.data)}
      return {...state, evidence: evidenceFor(state)}
    }

    const hasStepStart = latestParsed.some(part => part.type === "step-start" || part.type === "step_start")
    const hasStepFinish = latestParsed.some(part => part.type === "step-finish" || part.type === "step_finish")
    const completedToolParts = allParts
      .map(row => ({row, data: parseJson(rowValue(row, ["data", "json", "payload"])), time: rowTime(row)}))
      .filter(part => isToolPart(part.row, part.data) && toolStatus(part.data) === "completed")
      .sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
    const lastCompletedToolPart = completedToolParts.at(-1)
    const lastCompletedTool = lastCompletedToolPart ? toolFromPart(lastCompletedToolPart.row, lastCompletedToolPart.data) : undefined
    const previous = assistantMessages.find(item => messageId(item.row) !== latestId)
    const previousParts = partsFor(previous ? messageId(previous.row) : undefined)
    const previousFinish = previousParts
      .map(row => ({row, data: parseJson(rowValue(row, ["data", "json", "payload"]))}))
      .map(part => finishReason(part.row, part.data))
      .find(Boolean)
      ?? (previous ? finishReason(previous.row, previous.data) : undefined)

    if (hasStepStart && !hasStepFinish && messageAgeMs !== undefined && messageAgeMs >= (options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS)) {
      const kind = previousFinish === "tool-calls" && lastCompletedTool ? "model-stream-stalled-after-tool" as const : "model-stream-stalled" as const
      const state = {...base, kind, lastCompletedTool}
      return {...state, evidence: evidenceFor(state)}
    }

    const state = {...base, kind: "unknown-idle" as const, lastCompletedTool}
    return {...state, evidence: evidenceFor(state)}
  } catch (error) {
    return {kind: "unknown-idle", dbPath, evidence: `OpenCode database inspection failed: ${error instanceof Error ? error.message : String(error)}`}
  } finally {
    db.close()
  }
}

export const openCodeRuntimeStateHardFailure = (state: OpenCodeRuntimeState) => {
  if (state.kind !== "model-stream-stalled" && state.kind !== "model-stream-stalled-after-tool") return undefined
  return {
    category: "model-provider-stream-stalled" as const,
    reason: state.kind === "model-stream-stalled-after-tool"
      ? "OpenCode model response stream stalled after last completed tool"
      : "OpenCode model response stream stalled",
    evidence: state.evidence.slice(0, 240),
    retryable: true,
    fallbackEligible: true,
  }
}
