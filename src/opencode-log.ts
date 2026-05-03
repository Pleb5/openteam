const stripAnsi = (value: string) =>
  value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")

export const detectOpenCodeHardFailure = (text: string) => {
  const clean = stripAnsi(text)
  const checks: Array<[RegExp, string]> = [
    [/ProviderModelNotFoundError/i, "configured opencode model was not found by provider"],
    [/Model not found:\s*[^\n.]+/i, "configured opencode model was not found by provider"],
    [/No provider found for model|Provider not found|Unknown provider/i, "configured opencode provider was not found"],
    [/invalid (?:model )?variant|unknown variant/i, "configured opencode model variant was not accepted"],
    [/AuthenticationError|Unauthorized|invalid api key|missing api key/i, "model provider authentication failed"],
    [/"code"\s*:\s*"server_error"/i, "model provider returned server_error"],
    [/"type"\s*:\s*"server_error"/i, "model provider returned server_error"],
    [/permission requested:[\s\S]{0,300}auto-rejecting/i, "tool permission request was auto-rejected"],
    [/The user rejected permission to use this specific tool call\./i, "tool permission request was rejected"],
    [/sandbox (?:denied|blocked|rejected) the requested (?:tool|command|operation)/i, "sandbox policy blocked the requested operation"],
    [/operation blocked by OpenCode policy/i, "OpenCode policy blocked the requested operation"],
    [/Publication is still blocked|No branch push occurred|No PR URL was recorded|No upstream PR was created/i, "worker reported publication was blocked"],
  ]
  for (const [pattern, reason] of checks) {
    const match = clean.match(pattern)
    if (match) {
      return {reason, evidence: match[0].replace(/\s+/g, " ").slice(0, 240)}
    }
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
