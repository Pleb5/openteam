import {describe, expect, test} from "bun:test"
import {mkdir, mkdtemp, readFile, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {recordOperatorPreviewEvidence, startOperatorPreview, stopOperatorPreview} from "../src/operator-preview.js"
import {holdRepoContextForOperatorPreview, operatorPreviewJobId, releaseOperatorPreviewContextHold} from "../src/repo.js"
import type {AppCfg, RepoContext, RepoRegistry, TaskRunRecord, VerificationPlan} from "../src/types.js"

const makeApp = (runtimeRoot: string): AppCfg => ({
  root: process.cwd(),
  config: {
    runtimeRoot,
    opencode: {binary: "opencode", model: "", agent: "build"},
    browser: {headless: true, executablePath: "/usr/bin/chromium", mcp: {name: "playwright", command: [], environment: {}}},
    providers: {},
    repos: {
      app: {root: process.cwd(), baseBranch: "main", sharedPaths: [], mode: "web", devCommand: ["bun", "--version"], healthUrl: "data:text/plain,ok"},
    },
    reporting: {dmRelays: [], outboxRelays: [], relayListBootstrapRelays: [], appDataRelays: [], signerRelays: [], allowFrom: [], reportTo: []},
    nostr_git: {graspServers: [], gitDataRelays: [], repoAnnouncementRelays: [], forkGitOwner: "", forkRepoPrefix: "", forkCloneUrlTemplate: ""},
    agents: {
      "builder-01": {
        role: "builder",
        soul: "builder",
        repo: "app",
        portStart: 19500,
        reporting: {},
        identity: {npub: "", sec: "1111111111111111111111111111111111111111111111111111111111111111", bunkerProfile: "builder", nakClientKey: ""},
      },
    },
  },
})

const plan = (): VerificationPlan => ({
  version: 1,
  mode: "web",
  profileStacks: [],
  selectedRunnerIds: ["repo-native", "browser"],
  runners: [
    {id: "repo-native", kind: "command", enabled: true, configured: true, local: true, modes: ["web"], stacks: []},
    {id: "browser", kind: "playwright-mcp", enabled: true, configured: true, local: true, modes: ["web"], stacks: []},
  ],
})

const context = (checkout: string, patch: Partial<RepoContext> = {}): RepoContext => ({
  id: patch.id ?? "ctx1",
  repoKey: "30617:owner:repo",
  path: path.dirname(checkout),
  checkout,
  mirror: path.join(path.dirname(checkout), "mirror.git"),
  mode: "web",
  baseRef: "HEAD",
  baseCommit: "abc123",
  branch: "openteam/test",
  state: patch.state ?? "idle",
  lease: patch.lease,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...patch,
})

const runRecord = (app: AppCfg, checkout: string, patch: Partial<TaskRunRecord> = {}): TaskRunRecord => {
  const runId = patch.runId ?? "builder-01-task-a"
  const verificationPlan = plan()
  return {
    version: 1,
    runId,
    runFile: path.join(app.config.runtimeRoot, "runs", `${runId}.json`),
    taskId: "task-a",
    agentId: "builder-01",
    baseAgentId: "builder-01",
    role: "builder",
    task: "Preview a web change",
    target: "repo",
    mode: "web",
    state: "needs-review",
    startedAt: new Date().toISOString(),
    context: {id: "ctx1", checkout, branch: "openteam/test"},
    verification: {
      plan: verificationPlan,
      results: [{id: "repo-native", kind: "command", state: "succeeded", evidenceType: "repo-native", source: "runtime", note: "tests passed"}],
    },
    doneContract: {version: 1, role: "builder", mode: "web", taskClass: "general", summary: "done", requiredEvidence: [], successPolicy: [], prPolicy: "publish PRs when evidence is strong"},
    phases: [],
    ...patch,
  }
}

const writeRun = async (record: TaskRunRecord) => {
  await mkdir(path.dirname(record.runFile), {recursive: true})
  await writeFile(record.runFile, `${JSON.stringify(record, null, 2)}\n`)
}

const writeRegistry = async (app: AppCfg, registry: RepoRegistry) => {
  const file = path.join(app.config.runtimeRoot, "repos", "registry.json")
  await mkdir(path.dirname(file), {recursive: true})
  await writeFile(file, `${JSON.stringify(registry, null, 2)}\n`)
}

describe("operator preview", () => {
  test("records operator browser evidence in checkout and run record", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-preview-")))
    const checkout = path.join(app.config.runtimeRoot, "checkout")
    await mkdir(path.join(checkout, ".openteam"), {recursive: true})
    const verificationPlan = plan()
    await writeFile(path.join(checkout, ".openteam", "verification-plan.json"), `${JSON.stringify(verificationPlan, null, 2)}\n`)
    const record = runRecord(app, checkout, {
      operatorPreviews: [{version: 1, id: "preview-1", kind: "live-run", state: "live", requestedAt: new Date().toISOString(), runId: "builder-01-task-a", checkout, url: "data:text/plain,ok", source: "operator"}],
    })
    await writeRun(record)

    const result = await recordOperatorPreviewEvidence(app, record.runId, {state: "succeeded", note: "Clicked through the fixed UI"})
    const saved = JSON.parse(await readFile(record.runFile, "utf8")) as TaskRunRecord
    const fileResults = JSON.parse(await readFile(path.join(checkout, ".openteam", "verification-results.json"), "utf8"))

    expect(result.result.source).toBe("operator")
    expect(result.result.evidenceType).toBe("browser")
    expect(saved.state).toBe("succeeded")
    expect(saved.verification?.results?.at(-1)?.source).toBe("operator")
    expect(fileResults.at(-1).source).toBe("operator")
  })

  test("preview hold and release only use operator-preview leases", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-preview-")))
    const checkout = path.join(app.config.runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    await writeRegistry(app, {version: 1, repos: {}, contexts: {ctx1: context(checkout)}, forks: {}})

    await holdRepoContextForOperatorPreview(app, "ctx1", "run-a")
    let registry = JSON.parse(await readFile(path.join(app.config.runtimeRoot, "repos", "registry.json"), "utf8")) as RepoRegistry
    expect(registry.contexts.ctx1?.lease?.jobId).toBe(operatorPreviewJobId("run-a"))

    expect(await releaseOperatorPreviewContextHold(app, "ctx1", "other-run")).toBe(false)
    registry = JSON.parse(await readFile(path.join(app.config.runtimeRoot, "repos", "registry.json"), "utf8")) as RepoRegistry
    expect(registry.contexts.ctx1?.state).toBe("leased")

    expect(await releaseOperatorPreviewContextHold(app, "ctx1", "run-a")).toBe(true)
    registry = JSON.parse(await readFile(path.join(app.config.runtimeRoot, "repos", "registry.json"), "utf8")) as RepoRegistry
    expect(registry.contexts.ctx1?.state).toBe("idle")
  })

  test("healthy running web run returns a live-run preview", async () => {
    const app = makeApp(await mkdtemp(path.join(tmpdir(), "openteam-preview-")))
    const checkout = path.join(app.config.runtimeRoot, "checkout")
    await mkdir(checkout, {recursive: true})
    const record = runRecord(app, checkout, {
      state: "running",
      process: {runnerPid: process.pid, devPid: process.pid},
      devServer: {url: "data:text/plain,ok", pid: process.pid, startedAt: new Date().toISOString()},
      browser: {enabled: true, headless: true, profileDir: "/tmp/profile", artifactDir: "/tmp/artifacts", url: "data:text/plain,ok"},
      phases: [{name: "opencode-worker", state: "running", startedAt: new Date().toISOString()}],
    })
    await writeRegistry(app, {version: 1, repos: {}, contexts: {ctx1: context(checkout, {state: "leased", lease: {workerId: "builder-01", role: "builder", jobId: "task-a", mode: "web", leasedAt: new Date().toISOString()}})}, forks: {}})
    await writeRun(record)

    const result = await startOperatorPreview(app, record.runId)

    expect(result.preview.kind).toBe("live-run")
    expect(result.preview.url).toBe("data:text/plain,ok")

    const stopped = await stopOperatorPreview(app, record.runId)
    expect(stopped.stopped).toBe(false)
  })
})
