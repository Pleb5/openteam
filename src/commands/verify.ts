import {existsSync} from "node:fs"
import {readFile} from "node:fs/promises"
import {detectDevEnv} from "../dev-env.js"
import {
  appendVerificationResultsFile,
  manualVerificationResult,
  readProjectProfileForVerification,
  readVerificationPlan,
  readVerificationResults,
  runVerificationRunner,
  verificationPlanPath,
  verificationResultsPath,
} from "../verification.js"
import type {AppCfg, VerificationEvidenceType, VerificationRunnerKind, VerificationRunnerPlan, VerificationRunnerResult, VerificationPlan} from "../types.js"

const value = (args: string[], key: string) => {
  const index = args.indexOf(key)
  if (index === -1) return ""
  return args[index + 1] ?? ""
}

const values = (args: string[], key: string) => {
  const found: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === key && args[index + 1]) {
      found.push(args[index + 1])
    }
  }
  return found
}

const flag = (args: string[], key: string) => args.includes(key)

const checkoutFromRunFile = async () => {
  const file = process.env.OPENTEAM_RUN_FILE
  if (!file || !existsSync(file)) return ""
  try {
    const record = JSON.parse(await readFile(file, "utf8")) as {
      context?: {checkout?: string}
      result?: {checkout?: string}
    }
    return record.context?.checkout || record.result?.checkout || ""
  } catch {
    return ""
  }
}

const checkoutFromArgs = async (args: string[]) =>
  value(args, "--checkout") ||
  process.env.OPENTEAM_CHECKOUT ||
  await checkoutFromRunFile() ||
  process.cwd()

const requirePlan = async (checkout: string) => {
  const plan = await readVerificationPlan(checkout)
  if (!plan) throw new Error(`verification plan not found: ${verificationPlanPath(checkout)}`)
  return plan
}

const parseState = (value: string): VerificationRunnerResult["state"] => {
  if (value === "succeeded" || value === "failed" || value === "blocked" || value === "skipped") return value
  throw new Error(`invalid --state ${value || "(missing)"}`)
}

const parseOptionalState = (args: string[], fallback: VerificationRunnerResult["state"] = "succeeded") =>
  value(args, "--state") ? parseState(value(args, "--state")) : fallback

const parseEvidenceType = (raw: string): VerificationEvidenceType | undefined => {
  if (!raw) return undefined
  if (raw === "repo-native" || raw === "browser" || raw === "nostr" || raw === "desktop" || raw === "mobile" || raw === "manual" || raw === "runtime") return raw
  throw new Error(`invalid --type ${raw}`)
}

const kindForEvidenceType = (type: VerificationEvidenceType | undefined): VerificationRunnerKind => {
  if (type === "browser") return "playwright-mcp"
  if (type === "desktop") return "desktop-command"
  if (type === "mobile") return "android-adb"
  return "command"
}

const virtualRunner = (
  plan: VerificationPlan,
  id: string,
  type: VerificationEvidenceType | undefined,
): VerificationRunnerPlan => ({
  id,
  kind: kindForEvidenceType(type),
  enabled: true,
  configured: true,
  local: true,
  reason: "ad-hoc structured evidence record",
  modes: [plan.mode],
  stacks: [],
})

const runnerForRecord = (
  plan: VerificationPlan,
  id: string,
  type: VerificationEvidenceType | undefined,
) => plan.runners.find(item => item.id === id) ?? virtualRunner(plan, id, type)

const readTextValue = async (args: string[], key: string) => {
  const file = value(args, `${key}-file`)
  if (file) return readFile(file, "utf8")
  return value(args, key)
}

const unique = (items: string[]) => Array.from(new Set(items.filter(Boolean)))

const checkUrlHealth = async (url: string | undefined) => {
  if (!url) return undefined
  const attempt = async (method: "HEAD" | "GET") => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1500)
    try {
      const response = await fetch(url, {method, signal: controller.signal})
      return {ok: response.status >= 200 && response.status < 500, url, status: response.status, method, checkedAt: new Date().toISOString()}
    } catch (error) {
      return {ok: false, url, method, error: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString()}
    } finally {
      clearTimeout(timer)
    }
  }
  const head = await attempt("HEAD")
  if (head.ok || (head.status && head.status !== 405 && head.status !== 501)) return head
  return attempt("GET")
}

const evidencePatchFromArgs = async (
  args: string[],
  defaults: {
    state?: VerificationRunnerResult["state"]
    evidenceType?: VerificationEvidenceType
    url?: string
  } = {},
) => {
  const screenshots = values(args, "--screenshot")
  const state = parseOptionalState(args, defaults.state ?? (value(args, "--blocker") ? "blocked" : value(args, "--error") ? "failed" : "succeeded"))
  const url = value(args, "--url") || defaults.url || undefined
  const shouldCheckUrl = Boolean(url && (flag(args, "--dev-health") || flag(args, "--check-url")))
  return {
    state,
    evidenceType: parseEvidenceType(value(args, "--type")) ?? defaults.evidenceType,
    note: await readTextValue(args, "--note") || undefined,
    artifacts: unique([...values(args, "--artifact"), ...screenshots]),
    screenshots,
    url,
    flow: value(args, "--flow") || undefined,
    consoleSummary: await readTextValue(args, "--console") || undefined,
    networkSummary: await readTextValue(args, "--network") || undefined,
    eventIds: values(args, "--event-id"),
    error: value(args, "--error") || undefined,
    blocker: value(args, "--blocker") || undefined,
    skippedReason: value(args, "--reason") || undefined,
    urlHealth: shouldCheckUrl ? await checkUrlHealth(url) : undefined,
    source: "worker" as const,
  }
}

const printList = (value: unknown, json: boolean) => {
  if (json) {
    console.log(JSON.stringify(value, null, 2))
    return
  }
  const data = value as {
    checkout: string
    runners: Array<{id: string; kind: string; configured: boolean; reason?: string}>
    results: Array<{id: string; state: string; note?: string; logFile?: string; blocker?: string; error?: string}>
  }
  console.log(`checkout: ${data.checkout}`)
  for (const runner of data.runners) {
    console.log(`runner: ${runner.id} (${runner.kind}) ${runner.configured ? "configured" : `unavailable: ${runner.reason ?? "unknown"}`}`)
  }
  for (const result of data.results) {
    const detail = result.note ?? result.blocker ?? result.error ?? result.logFile ?? ""
    console.log(`result: ${result.id} ${result.state}${detail ? ` (${detail})` : ""}`)
  }
}

export const verifyCommand = async (app: AppCfg, sub: string | undefined, args: string[]) => {
  const json = flag(args, "--json")
  const checkout = await checkoutFromArgs(args)

  if (sub === "list") {
    const plan = await requirePlan(checkout)
    const results = await readVerificationResults(checkout)
    printList({
      checkout,
      planPath: verificationPlanPath(checkout),
      resultsPath: verificationResultsPath(checkout),
      runners: plan.runners,
      results,
    }, json)
    return
  }

  if (sub === "run") {
    const runnerId = args[2]
    if (!runnerId || runnerId.startsWith("--")) throw new Error("missing runner id")
    const plan = await requirePlan(checkout)
    const profile = await readProjectProfileForVerification(checkout)
    const devEnv = await detectDevEnv(checkout)
    const results = await runVerificationRunner({
      checkout,
      plan,
      runnerId,
      profile,
      devEnv,
      source: "worker",
    })
    await appendVerificationResultsFile(checkout, results)
    console.log(JSON.stringify(results, null, 2))
    return
  }

  if (sub === "record") {
    const runnerId = args[2]
    if (!runnerId || runnerId.startsWith("--")) throw new Error("missing runner id")
    const plan = await requirePlan(checkout)
    const evidenceType = parseEvidenceType(value(args, "--type"))
    const runner = runnerForRecord(plan, runnerId, evidenceType)
    const result = manualVerificationResult(runner, await evidencePatchFromArgs(args, {evidenceType}))
    await appendVerificationResultsFile(checkout, [result])
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (sub === "browser") {
    const plan = await requirePlan(checkout)
    const runner = runnerForRecord(plan, "browser", "browser")
    const result = manualVerificationResult(runner, await evidencePatchFromArgs(args, {
      evidenceType: "browser",
      url: process.env.OPENTEAM_DEV_URL,
    }))
    await appendVerificationResultsFile(checkout, [result])
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (sub === "artifact") {
    const artifact = args[2]
    if (!artifact || artifact.startsWith("--")) throw new Error("missing artifact path")
    const plan = await requirePlan(checkout)
    const evidenceType = parseEvidenceType(value(args, "--type")) ?? "manual"
    const runner = runnerForRecord(plan, value(args, "--runner") || value(args, "--id") || `${evidenceType}-artifact`, evidenceType)
    const patch = await evidencePatchFromArgs(args, {evidenceType})
    const result = manualVerificationResult(runner, {
      ...patch,
      artifacts: unique([artifact, ...(patch.artifacts ?? [])]),
      screenshots: evidenceType === "browser" ? unique([artifact, ...(patch.screenshots ?? [])]) : patch.screenshots,
    })
    await appendVerificationResultsFile(checkout, [result])
    console.log(JSON.stringify(result, null, 2))
    return
  }

  throw new Error("expected verify list|run|record|browser|artifact")
}
