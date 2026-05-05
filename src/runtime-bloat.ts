import {existsSync, type Dirent} from "node:fs"
import {readdir, stat} from "node:fs/promises"
import path from "node:path"

export type RuntimeBloatEntry = {
  path: string
  relativePath: string
  kind: string
  sizeBytes: number
  files: number
  directories: number
  truncated: boolean
  watchRisk: boolean
}

export type RuntimeBloatReport = {
  checkout: string
  generatedAt: string
  entries: RuntimeBloatEntry[]
}

const DEFAULT_SIZE_THRESHOLD_BYTES = 50 * 1024 * 1024
const DEFAULT_FILE_THRESHOLD = 5000
const DEFAULT_SCAN_LIMIT = 100_000

const checkoutLocalRuntimeDirs = [
  {relativePath: ".openteam/opencode", kind: "checkout-local OpenCode runtime", watchRisk: true},
  {relativePath: ".openteam/cache", kind: "checkout-local tool/package cache", watchRisk: true},
  {relativePath: ".openteam/tmp", kind: "checkout-local temp files", watchRisk: true},
  {relativePath: ".openteam/artifacts", kind: "checkout-local artifacts", watchRisk: true},
  {relativePath: ".opencode", kind: "checkout-local OpenCode config/plugins", watchRisk: true},
  {relativePath: "runtime", kind: "checkout-local runtime directory", watchRisk: true},
  {relativePath: "playwright-report", kind: "checkout-local Playwright report", watchRisk: true},
  {relativePath: "test-results", kind: "checkout-local test artifacts", watchRisk: true},
  {relativePath: "coverage", kind: "checkout-local coverage output", watchRisk: true},
]

const emptyStats = () => ({sizeBytes: 0, files: 0, directories: 0, truncated: false})

const scanDir = async (dir: string, limit: number) => {
  const result = emptyStats()
  const visit = async (current: string) => {
    if (result.files + result.directories >= limit) {
      result.truncated = true
      return
    }
    let entries: Dirent[]
    try {
      entries = await readdir(current, {withFileTypes: true})
    } catch {
      return
    }
    for (const entry of entries) {
      if (result.files + result.directories >= limit) {
        result.truncated = true
        return
      }
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        result.directories += 1
        await visit(full)
        continue
      }
      result.files += 1
      const info = await stat(full).catch(() => undefined)
      if (info?.isFile()) result.sizeBytes += info.size
    }
  }
  await visit(dir)
  return result
}

export const scanCheckoutRuntimeBloat = async (checkout: string, options: {
  sizeThresholdBytes?: number
  fileThreshold?: number
  scanLimit?: number
  includeBelowThreshold?: boolean
} = {}): Promise<RuntimeBloatReport> => {
  const sizeThresholdBytes = options.sizeThresholdBytes ?? DEFAULT_SIZE_THRESHOLD_BYTES
  const fileThreshold = options.fileThreshold ?? DEFAULT_FILE_THRESHOLD
  const scanLimit = options.scanLimit ?? DEFAULT_SCAN_LIMIT
  const entries: RuntimeBloatEntry[] = []

  for (const candidate of checkoutLocalRuntimeDirs) {
    const full = path.join(checkout, candidate.relativePath)
    if (!existsSync(full)) continue
    const info = await stat(full).catch(() => undefined)
    if (!info?.isDirectory()) continue
    const stats = await scanDir(full, scanLimit)
    const overThreshold = stats.sizeBytes >= sizeThresholdBytes || stats.files >= fileThreshold || stats.truncated
    if (!overThreshold && !options.includeBelowThreshold) continue
    entries.push({
      path: full,
      relativePath: candidate.relativePath,
      kind: candidate.kind,
      sizeBytes: stats.sizeBytes,
      files: stats.files,
      directories: stats.directories,
      truncated: stats.truncated,
      watchRisk: candidate.watchRisk,
    })
  }

  return {
    checkout,
    generatedAt: new Date().toISOString(),
    entries,
  }
}

export const formatRuntimeBloatSummary = (report: RuntimeBloatReport) =>
  report.entries.map(entry => {
    const mb = (entry.sizeBytes / 1024 / 1024).toFixed(1)
    const truncated = entry.truncated ? ", scan truncated" : ""
    return `${entry.relativePath}: ${mb} MiB, ${entry.files} files, ${entry.directories} dirs${truncated}`
  })
