import {existsSync} from "node:fs"
import {spawnSync} from "node:child_process"
import {scoreRoleFinalResponse} from "./eval-fixtures.js"
import {readVerificationResults} from "./verification.js"
import type {TaskRunRecord} from "./types.js"

export type RunProgressSignals = {
  checkout?: string
  checkoutExists: boolean
  worktreeChanged: boolean
  worktreeChangedPaths: string[]
  commitsAfterBase: boolean
  commitsAfterBaseCount?: number
  verificationResultCount: number
  finalResponseLabelsComplete: boolean
  hasImplementationProgress: boolean
  reasons: string[]
}

const git = (checkout: string, args: string[]) =>
  spawnSync("git", args, {cwd: checkout, encoding: "utf8", maxBuffer: 1024 * 1024})

const unquotePath = (value: string) => {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string
    } catch {}
  }
  return trimmed
}

const statusPath = (line: string) => {
  const raw = line.slice(3).trim()
  const renamed = raw.includes(" -> ") ? raw.split(" -> ").at(-1) ?? raw : raw
  return unquotePath(renamed)
}

const isRuntimeOnlyPath = (file: string) =>
  file === ".openteam" ||
  file.startsWith(".openteam/") ||
  file === ".openteam.vite.config.ts"

const worktreeChanges = (checkout: string) => {
  const result = git(checkout, ["status", "--porcelain"])
  if (result.status !== 0) return []
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map(statusPath)
    .filter(file => file && !isRuntimeOnlyPath(file))
}

const commitsAfterBase = (checkout: string, baseCommit?: string) => {
  if (!baseCommit) return undefined
  const result = git(checkout, ["rev-list", "--count", `${baseCommit}..HEAD`])
  if (result.status !== 0) return undefined
  const count = Number.parseInt(result.stdout.trim(), 10)
  return Number.isFinite(count) ? count : undefined
}

export const runImplementationProgressSignals = async (
  record: TaskRunRecord,
  options: {checkout?: string; includeCheckoutEvidence?: boolean} = {},
): Promise<RunProgressSignals> => {
  const checkout = options.checkout ?? record.context?.checkout
  const checkoutExists = Boolean(checkout && existsSync(checkout))
  const worktreeChangedPaths = checkoutExists ? worktreeChanges(checkout!) : []
  const afterBaseCount = checkoutExists ? commitsAfterBase(checkout!, record.context?.baseCommit) : undefined
  const checkoutEvidence = options.includeCheckoutEvidence && checkoutExists
    ? await readVerificationResults(checkout!).catch(() => [])
    : []
  const verificationResultCount = (record.verification?.results ?? []).length + checkoutEvidence.length
  const finalResponseLabelsComplete = Boolean(
    record.finalResponse?.text && scoreRoleFinalResponse(record.role, record.finalResponse.text).missingLabels.length === 0,
  )

  const reasons = [
    worktreeChangedPaths.length > 0 ? `worktree has non-runtime changes: ${worktreeChangedPaths.slice(0, 5).join(", ")}` : "",
    afterBaseCount && afterBaseCount > 0 ? `checkout has ${afterBaseCount} commit(s) after base` : "",
    verificationResultCount > 0 ? `verification has ${verificationResultCount} recorded result(s)` : "",
    finalResponseLabelsComplete ? "final response labels are complete" : "",
  ].filter(Boolean)

  return {
    checkout,
    checkoutExists,
    worktreeChanged: worktreeChangedPaths.length > 0,
    worktreeChangedPaths,
    commitsAfterBase: Boolean(afterBaseCount && afterBaseCount > 0),
    commitsAfterBaseCount: afterBaseCount,
    verificationResultCount,
    finalResponseLabelsComplete,
    hasImplementationProgress: reasons.length > 0,
    reasons,
  }
}
