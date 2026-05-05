const stripAnsi = (value: string) =>
  value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")

export type OpenCodeHardFailureCategory =
  | "opencode-database-locked"
  | "model-config-invalid"
  | "model-unavailable"
  | "model-provider-unavailable"
  | "model-provider-auth-failed"
  | "model-provider-overloaded"
  | "model-provider-rate-limited"
  | "model-provider-server-error"
  | "model-provider-timeout"
  | "model-provider-network-error"
  | "model-provider-stream-stalled"
  | "model-provider-quota-exceeded"
  | "model-context-length-exceeded"
  | "opencode-auth-unavailable"
  | "tool-permission-rejected"
  | "opencode-policy-blocked"
  | "publication-blocked"
  | "opencode-runtime-error"

export type OpenCodeHardFailure = {
  category: OpenCodeHardFailureCategory
  reason: string
  evidence: string
  retryable: boolean
  fallbackEligible?: boolean
}

const cleanEvidence = (value: string) =>
  value.replace(/\s+/g, " ").slice(0, 240)

const failure = (
  match: string,
  category: OpenCodeHardFailureCategory,
  reason: string,
  retryable = false,
  fallbackEligible = false,
): OpenCodeHardFailure => ({
  category,
  reason,
  evidence: cleanEvidence(match),
  retryable,
  fallbackEligible,
})

const stringValue = (value: unknown) => typeof value === "string" ? value : ""

const classifyProviderErrorText = (text: string, evidence = text) => {
  const clean = text.replace(/\s+/g, " ")
  if (/context[_ -]?length[_ -]?exceeded|context window|maximum context|token limit|prompt is too long|input is too long|request entity too large|\b413\b/i.test(clean)) {
    return failure(evidence, "model-context-length-exceeded", "model input exceeded the context window")
  }
  if (/insufficient_quota|quota exceeded|billing|credits exhausted|free usage exceeded|usage_not_included/i.test(clean)) {
    return failure(evidence, "model-provider-quota-exceeded", "model provider quota or billing limit was reached", false, true)
  }
  if (/server_is_overloaded|service_unavailable_error|servers? (?:are )?(?:currently )?overloaded|provider is overloaded|\boverloaded\b/i.test(clean)) {
    return failure(evidence, "model-provider-overloaded", "model provider is overloaded", true, true)
  }
  if (/too_many_requests|rate[_ -]?limit|\brate limited\b|\b429\b/i.test(clean)) {
    return failure(evidence, "model-provider-rate-limited", "model provider rate limit was reached", true, true)
  }
  if (/request timed out|timed out|timeout|deadline exceeded|gateway timeout|\b504\b/i.test(clean)) {
    return failure(evidence, "model-provider-timeout", "model provider request timed out", true, true)
  }
  if (/ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|network error|fetch failed|connection reset/i.test(clean)) {
    return failure(evidence, "model-provider-network-error", "model provider network request failed", true, true)
  }
  if (/\b(?:500|502|503)\b|server_error|internal server error|bad gateway|service unavailable/i.test(clean)) {
    return failure(evidence, "model-provider-server-error", "model provider returned a transient server error", true, true)
  }
  return undefined
}

const classifyProviderErrorJson = (value: unknown, evidence: string) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const body = value as Record<string, unknown>
  const error = body.error && typeof body.error === "object" && !Array.isArray(body.error)
    ? body.error as Record<string, unknown>
    : undefined
  const text = [
    stringValue(body.type),
    stringValue(body.code),
    stringValue(body.message),
    stringValue(error?.type),
    stringValue(error?.code),
    stringValue(error?.message),
  ].filter(Boolean).join(" ")
  return text ? classifyProviderErrorText(text, evidence) : undefined
}

const structuredProviderFailure = (text: string) => {
  for (const line of text.split(/\r?\n/)) {
    if (!/[{}]/.test(line) || !/\b(?:error|code|type|message)\b/i.test(line)) continue
    const start = line.indexOf("{")
    const end = line.lastIndexOf("}")
    if (start === -1 || end <= start) continue
    const snippet = line.slice(start, end + 1)
    try {
      const parsed = JSON.parse(snippet)
      const classified = classifyProviderErrorJson(parsed, snippet)
      if (classified) return classified
    } catch {}
  }
  return undefined
}

export const detectOpenCodeHardFailure = (text: string) => {
  const clean = stripAnsi(text)
  const structured = structuredProviderFailure(clean)
  if (structured) return structured

  const checks: Array<[RegExp, OpenCodeHardFailureCategory, string, boolean?, boolean?]> = [
    [/Error:\s*database is locked/i, "opencode-database-locked", "OpenCode runtime database was locked", true],
    [/\bdatabase is locked\b/i, "opencode-database-locked", "OpenCode runtime database was locked", true],
    [/ProviderModelNotFoundError/i, "model-unavailable", "configured opencode model was not found by provider", false, true],
    [/Model not found:\s*[^\n.]+/i, "model-config-invalid", "configured opencode model was not found by provider", false, true],
    [/No provider found for model|Provider not found|Unknown provider/i, "model-provider-unavailable", "configured opencode provider was not found", false, true],
    [/invalid (?:model )?variant|unknown variant/i, "model-config-invalid", "configured opencode model variant was not accepted", false, true],
    [/missing (?:opencode )?auth|auth\.json.*(?:missing|not found)|no auth state/i, "opencode-auth-unavailable", "OpenCode auth state was unavailable"],
    [/AuthenticationError|Unauthorized|invalid api key|missing api key/i, "model-provider-auth-failed", "model provider authentication failed", false, true],
    [/models\.dev.*(?:timed out|timeout|failed to fetch)/i, "model-provider-unavailable", "OpenCode model registry lookup failed", true],
    [/server_is_overloaded|service_unavailable_error|servers? (?:are )?(?:currently )?overloaded|\boverloaded\b/i, "model-provider-overloaded", "model provider is overloaded", true, true],
    [/too_many_requests|rate[_ -]?limit|\brate limited\b|\b429\b/i, "model-provider-rate-limited", "model provider rate limit was reached", true, true],
    [/request timed out|timed out|timeout|deadline exceeded|gateway timeout|\b504\b/i, "model-provider-timeout", "model provider request timed out", true, true],
    [/ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|network error|fetch failed|connection reset/i, "model-provider-network-error", "model provider network request failed", true, true],
    [/model (?:provider )?(?:response )?stream stalled|model-provider-stream-stalled/i, "model-provider-stream-stalled", "OpenCode model response stream stalled", true, true],
    [/"code"\s*:\s*"server_error"|"type"\s*:\s*"server_error"|\b(?:500|502|503)\b|internal server error|bad gateway|service unavailable/i, "model-provider-server-error", "model provider returned a transient server error", true, true],
    [/permission requested:[\s\S]{0,300}auto-rejecting/i, "tool-permission-rejected", "tool permission request was auto-rejected"],
    [/The user rejected permission to use this specific tool call\./i, "tool-permission-rejected", "tool permission request was rejected"],
    [/sandbox (?:denied|blocked|rejected) the requested (?:tool|command|operation)/i, "opencode-policy-blocked", "sandbox policy blocked the requested operation"],
    [/operation blocked by OpenCode policy/i, "opencode-policy-blocked", "OpenCode policy blocked the requested operation"],
    [/Publication is still blocked|No branch push occurred|No PR URL was recorded|No upstream PR was created/i, "publication-blocked", "worker reported publication was blocked"],
    [/\b(?:panic|fatal panic|unhandled exception|uncaught exception)\b/i, "opencode-runtime-error", "OpenCode runtime crashed or threw an unhandled exception"],
  ]
  for (const [pattern, category, reason, retryable, fallbackEligible] of checks) {
    const match = clean.match(pattern)
    if (match) {
      return failure(match[0], category, reason, Boolean(retryable), Boolean(fallbackEligible))
    }
  }

  const lastLine = lastMeaningfulLogLine(clean)
  if (lastLine?.match(/^Error:\s+\S+/i)) {
    return failure(lastLine, "opencode-runtime-error", "OpenCode exited with a terminal runtime error")
  }

  return undefined
}

export const detectWorkerVerificationBlockers = (text: string) => {
  const clean = stripAnsi(text)
  const checks: Array<[RegExp, string]> = [
    [/\b(SIGTRAP)\b/i, "browser/runtime process exited with SIGTRAP"],
    [/\bsvelte-kit\b[^\n]*(?:not found|executable|failed|exited\s+127|code\s+127)/i, "svelte-kit executable failed or was unavailable"],
    [/npm (?:ERR! )?code EOVERRIDE|override conflict/i, "npm dependency override conflict"],
    [/gitlint:\s*command not found|No module named ['"]?gitlint\.cli/i, "repo commit hook requires gitlint but it was unavailable"],
    [/gh auth login|GH_TOKEN environment variable|gh auth status reports no logged-in GitHub host|You are not logged into any GitHub hosts/i, "GitHub CLI auth was unavailable"],
    [/Publication is still blocked|No branch push occurred|No PR URL was recorded|No upstream PR was created/i, "worker reported publication was blocked"],
    [/\b(?:check|build|test)[^\n]*(?:exited\s+(?:with\s+)?(?:code\s+)?127|command not found)/i, "repo validation command failed because an executable was unavailable"],
    [/Playwright[^\n]*(?:failed|crash|SIGTRAP|exited)/i, "Playwright browser validation failed"],
  ]
  return checks.flatMap(([pattern, reason]) => {
    const match = clean.match(pattern)
    return match ? [{reason, evidence: match[0].replace(/\s+/g, " ").slice(0, 240)}] : []
  })
}

export type OpenCodeToolBoundary = {
  tool: string
  started: number
  completed: number
  inFlight: boolean
}

export const detectOpenCodeToolBoundaries = (text: string) => {
  const clean = stripAnsi(text)
  const tools = new Map<string, OpenCodeToolBoundary>()
  const pattern = /^.*service=tool\.registry\s+status=(started|completed)[^\n]*$/gm
  for (const match of clean.matchAll(pattern)) {
    const status = match[1]
    const tool = match[0].trim().split(/\s+/).at(-1) ?? "unknown"
    const current = tools.get(tool) ?? {tool, started: 0, completed: 0, inFlight: false}
    if (status === "started") current.started += 1
    if (status === "completed") current.completed += 1
    current.inFlight = current.started > current.completed
    tools.set(tool, current)
  }
  return [...tools.values()]
}

export type OpenCodeBlockedKind = "permission" | "question" | "policy"

export const detectOpenCodeBlockedState = (text: string) => {
  const clean = stripAnsi(text)
  const checks: Array<[RegExp, OpenCodeBlockedKind, string]> = [
    [/permission requested:[^\n]*(?:\n[^\n]*){0,3}/i, "permission", "OpenCode requested a permission decision"],
    [/The user rejected permission to use this specific tool call\./i, "permission", "OpenCode permission request was rejected"],
    [/auto-rejecting[^\n]*/i, "permission", "OpenCode permission request was auto-rejected"],
    [/\b(?:Question|Ask|User input requested)\b[^\n]*(?:\n[^\n]*){0,3}/i, "question", "OpenCode requested interactive user input"],
    [/\b(?:Should I|Would you like me to|Do you want me to|Please confirm|Please choose)\b[^\n]*\?/i, "question", "worker appears to be waiting for an interactive decision"],
    [/operation blocked by OpenCode policy|sandbox (?:denied|blocked|rejected) the requested (?:tool|command|operation)/i, "policy", "OpenCode policy blocked the requested operation"],
  ]
  for (const [pattern, kind, reason] of checks) {
    const match = clean.match(pattern)
    if (match) {
      return {kind, reason, evidence: match[0].replace(/\s+/g, " ").slice(0, 240)}
    }
  }
  return undefined
}

export const lastMeaningfulLogLine = (text: string) => {
  const lines = stripAnsi(text)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  return lines.at(-1)?.replace(/\s+/g, " ").slice(0, 240)
}
