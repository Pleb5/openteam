import {describe, expect, test} from "bun:test"
import {mkdir, mkdtemp, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {runsEval} from "../src/commands/runs.js"
import {createDoneContract} from "../src/done-contract.js"
import {buildFinalResponseRecord, createOutputTailCapture} from "../src/final-response.js"
import {evaluateRunRecord} from "../src/run-evals.js"
import type {AppCfg, TaskRunRecord, VerificationPlan, VerificationRunnerResult} from "../src/types.js"

const verificationPlan: VerificationPlan = {
  version: 1,
  mode: "code",
  profileStacks: [],
  selectedRunnerIds: ["repo-native"],
  runners: [{
    id: "repo-native",
    kind: "command",
    enabled: true,
    configured: true,
    local: true,
    command: ["bun", "test"],
    modes: ["code"],
    stacks: [],
  }],
}

const commandEvidence = (note = "Verified the implementation with repo-native tests."): VerificationRunnerResult => ({
  id: "repo-native",
  kind: "command",
  evidenceType: "repo-native",
  state: "succeeded",
  source: "worker",
  command: ["bun", "test"],
  logFile: ".openteam/artifacts/verification/repo-native.log",
  note,
})

const browserEvidence = (): VerificationRunnerResult => ({
  id: "browser",
  kind: "playwright-mcp",
  evidenceType: "browser",
  state: "succeeded",
  source: "worker",
  screenshots: [".openteam/artifacts/browser/login.png"],
  note: "Verified the login flow in browser.",
})

const runRecord = (patch: Partial<TaskRunRecord> = {}): TaskRunRecord => ({
  version: 1,
  runId: "builder-01-fix-helper",
  runFile: "/repo/runtime/runs/builder-01-fix-helper.json",
  taskId: "fix-helper",
  agentId: "builder-01",
  baseAgentId: "builder-01",
  role: "builder",
  task: "Fix helper crash",
  target: "app",
  mode: "code",
  state: "needs-review",
  workerState: "succeeded",
  startedAt: "2026-05-01T00:00:00.000Z",
  finishedAt: "2026-05-01T00:01:00.000Z",
  doneContract: createDoneContract("builder", "code", "Fix helper crash"),
  verification: {
    planPath: ".openteam/verification-plan.json",
    plan: verificationPlan,
    results: [],
  },
  phases: [{name: "opencode-worker", state: "succeeded"}],
  ...patch,
})

const completeBuilderFinal = [
  "Summary: fixed the helper crash.",
  "Changed Files: src/helper.ts",
  "Verification: bun test tests/helper.test.ts",
  "Evidence Level: strong",
  "Publication Readiness: PR eligible",
  "Blockers: none",
].join("\n")

const app = (runtimeRoot: string): AppCfg => ({
  root: "/repo",
  config: {
    runtimeRoot,
    opencode: {binary: "opencode", model: "", agent: "build"},
    browser: {
      headless: true,
      mcp: {name: "playwright", command: [], environment: {}},
    },
    providers: {},
    repos: {},
    reporting: {
      dmRelays: [],
      outboxRelays: [],
      relayListBootstrapRelays: [],
      appDataRelays: [],
      signerRelays: [],
      allowFrom: [],
      reportTo: [],
    },
    nostr_git: {
      graspServers: [],
      gitDataRelays: [],
      repoAnnouncementRelays: [],
      forkGitOwner: "",
      forkRepoPrefix: "",
      forkCloneUrlTemplate: "",
    },
    agents: {},
  },
})

const withRunFile = (record: TaskRunRecord, runtimeRoot: string): TaskRunRecord => ({
  ...record,
  runFile: path.join(runtimeRoot, "runs", `${record.runId}.json`),
})

const writeRun = async (record: TaskRunRecord) => {
  await mkdir(path.dirname(record.runFile), {recursive: true})
  await writeFile(record.runFile, `${JSON.stringify(record, null, 2)}\n`)
}

const captureConsole = async <T>(fn: () => Promise<T>) => {
  const original = console.log
  const lines: string[] = []
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "))
  }
  try {
    const result = await fn()
    return {result, text: lines.join("\n"), lines}
  } finally {
    console.log = original
  }
}

describe("offline run-record evals", () => {
  test("scores a strong builder run with complete final response as clean", () => {
    const record = runRecord({
      state: "succeeded",
      verification: {
        planPath: ".openteam/verification-plan.json",
        plan: verificationPlan,
        results: [
          commandEvidence("Reproduced the helper crash before the fix and verified the fixed behavior."),
        ],
      },
      result: {
        id: "fix-helper",
        state: "succeeded",
        workerState: "succeeded",
        verificationState: "succeeded",
        evidenceLevel: "strong",
        prEligible: true,
        task: "Fix helper crash",
        target: "app",
        mode: "code",
        branch: "openteam/fix-helper",
        url: "",
        logFile: "/repo/runtime/agents/builder-01/artifacts/fix-helper-opencode.log",
      },
    })

    const evaluation = evaluateRunRecord(record, {finalResponseText: completeBuilderFinal})

    expect(evaluation.ok).toBe(true)
    expect(evaluation.score).toBe(100)
    expect(evaluation.evidenceLevel).toBe("strong")
    expect(evaluation.prEligible).toBe(true)
    expect(evaluation.findings).toHaveLength(0)
  })

  test("uses stored final response text by default", () => {
    const record = runRecord({
      state: "succeeded",
      finalResponse: buildFinalResponseRecord({
        text: completeBuilderFinal,
        capturedAt: "2026-05-01T00:01:00.000Z",
        logFile: "/repo/runtime/agents/builder-01/artifacts/fix-helper-opencode.log",
      }),
      verification: {
        planPath: ".openteam/verification-plan.json",
        plan: verificationPlan,
        results: [
          commandEvidence("Reproduced the helper crash before the fix and verified the fixed behavior."),
        ],
      },
    })

    const evaluation = evaluateRunRecord(record)

    expect(evaluation.ok).toBe(true)
    expect(evaluation.finalResponse?.available).toBe(true)
    expect(evaluation.finalResponse?.source).toBe("opencode-output-tail")
    expect(evaluation.finalResponse?.missingLabels).toEqual([])
  })

  test("captures a bounded redacted final output tail", () => {
    const capture = createOutputTailCapture(10)
    capture.append("abcdef")
    capture.append("ghijkl")
    const snapshot = capture.snapshot()
    const record = buildFinalResponseRecord({
      text: `\u001b[32m${snapshot.text}\u001b[0m\nSECRET_TOKEN=abc123\nnsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq`,
      truncated: snapshot.truncated,
      capturedAt: "2026-05-01T00:01:00.000Z",
    })

    expect(snapshot).toEqual({text: "cdefghijkl", truncated: true})
    expect(record?.text).toContain("cdefghijkl")
    expect(record?.text).toContain("SECRET_TOKEN=[REDACTED]")
    expect(record?.text).not.toContain("abc123")
    expect(record?.text).not.toContain("\u001b")
    expect(record?.truncated).toBe(true)
  })

  test("fails eval consistency when a succeeded run lacks strong evidence", () => {
    const evaluation = evaluateRunRecord(runRecord({state: "succeeded"}), {
      finalResponseText: [
        "Summary: changed the helper.",
        "Changed Files: src/helper.ts",
        "Verification: not run",
        "Evidence Level: missing",
        "Publication Readiness: blocked",
        "Blockers: verification missing",
      ].join("\n"),
    })

    expect(evaluation.ok).toBe(false)
    expect(evaluation.evidenceLevel).toBe("none")
    expect(evaluation.failures.map(item => item.code)).toContain("succeeded-without-strong-evidence")
  })

  test("keeps needs-review with missing evidence eval-safe but warns", () => {
    const evaluation = evaluateRunRecord(runRecord(), {
      finalResponseText: [
        "Summary: implemented the likely fix.",
        "Changed Files: src/helper.ts",
        "Verification: blocked by missing dependency install.",
        "Evidence Level: missing",
        "Publication Readiness: blocked",
        "Blockers: dependency install is unavailable in the checkout.",
      ].join("\n"),
    })

    expect(evaluation.ok).toBe(true)
    expect(evaluation.score).toBeLessThan(100)
    expect(evaluation.warnings.map(item => item.code)).toContain("needs-review-with-incomplete-evidence")
    expect(evaluation.failures).toHaveLength(0)
  })

  test("fails publication-safety mismatches", () => {
    const evaluation = evaluateRunRecord(runRecord({
      result: {
        id: "fix-helper",
        state: "needs-review",
        evidenceLevel: "none",
        prEligible: true,
        task: "Fix helper crash",
        target: "app",
        mode: "code",
        branch: "openteam/fix-helper",
        url: "",
        logFile: "/repo/runtime/agents/builder-01/artifacts/fix-helper-opencode.log",
      },
    }), {
      finalResponseText: [
        "Summary: changed the helper.",
        "Changed Files: src/helper.ts",
        "Verification: not run",
        "Evidence Level: strong",
        "Publication Readiness: PR eligible",
        "Blockers: none",
      ].join("\n"),
    })

    expect(evaluation.ok).toBe(false)
    expect(evaluation.failures.map(item => item.code)).toContain("result-pr-eligible-mismatch")
    expect(evaluation.failures.map(item => item.code)).toContain("final-response-overclaims-evidence")
    expect(evaluation.failures.map(item => item.code)).toContain("final-response-overclaims-publication-readiness")
  })

  test("fails missing role final-response labels when text is provided", () => {
    const record = runRecord({
      state: "needs-review",
      verification: {
        planPath: ".openteam/verification-plan.json",
        plan: verificationPlan,
        results: [commandEvidence()],
      },
    })
    const evaluation = evaluateRunRecord(record, {
      finalResponseText: [
        "Summary: changed the helper.",
        "Changed Files: src/helper.ts",
        "Publication Readiness: blocked",
        "Blockers: forgot to include checks.",
      ].join("\n"),
    })

    expect(evaluation.ok).toBe(false)
    expect(evaluation.finalResponse?.missingLabels).toEqual(["Verification", "Evidence Level"])
    expect(evaluation.failures.map(item => item.code)).toContain("final-response-contract-missing-labels")
  })

  test("flags failed terminal records that lack diagnostics", () => {
    const missingDiagnostic = evaluateRunRecord(runRecord({
      state: "failed",
      workerState: "failed",
      phases: [{name: "opencode-worker", state: "failed"}],
    }), {
      finalResponseText: [
        "Summary: failed before implementation.",
        "Changed Files: none",
        "Verification: not run",
        "Evidence Level: failed",
        "Publication Readiness: blocked",
        "Blockers: unknown",
      ].join("\n"),
    })

    const withDiagnostic = evaluateRunRecord(runRecord({
      state: "failed",
      workerState: "failed",
      failureCategory: "task-runtime-error",
      error: "OpenCode exited with code 1",
      phases: [{name: "opencode-worker", state: "failed", error: "OpenCode exited with code 1"}],
    }), {
      finalResponseText: [
        "Summary: failed before implementation.",
        "Changed Files: none",
        "Verification: not run",
        "Evidence Level: failed",
        "Publication Readiness: blocked",
        "Blockers: OpenCode exited with code 1.",
      ].join("\n"),
    })

    expect(missingDiagnostic.ok).toBe(false)
    expect(missingDiagnostic.failures.map(item => item.code)).toContain("terminal-run-missing-diagnostic")
    expect(withDiagnostic.ok).toBe(true)
  })

  test("scores researcher handoff quality without granting PR eligibility", () => {
    const record = runRecord({
      runId: "researcher-01-dependency-risk",
      agentId: "researcher-01",
      baseAgentId: "researcher-01",
      role: "researcher",
      task: "Research dependency risk",
      state: "succeeded",
      workerState: "succeeded",
      doneContract: createDoneContract("researcher", "code", "Research dependency risk"),
      verification: {
        planPath: ".openteam/verification-plan.json",
        plan: verificationPlan,
        results: [{
          id: "research-note",
          kind: "command",
          state: "succeeded",
          source: "worker",
          note: "Question answered; inspected dependency metadata, repo files, risks, and builder handoff.",
        }],
      },
    })
    const evaluation = evaluateRunRecord(record, {
      finalResponseText: [
        "Findings: the dependency upgrade is safe only with a pinned artifact.",
        "Risks: mutable tag and missing checksum verification.",
        "Evidence: inspected package metadata and lockfile.",
        "Recommendation: ask builder to pin an immutable artifact.",
        "Handoff: builder: pin the dependency artifact and run install validation.",
      ].join("\n"),
    })

    expect(evaluation.ok).toBe(true)
    expect(evaluation.evidenceLevel).toBe("strong")
    expect(evaluation.prEligible).toBe(false)
    expect(evaluation.failures).toHaveLength(0)
  })

  test("fails QA final responses that omit the verdict label", () => {
    const record = runRecord({
      runId: "qa-01-login-flow",
      agentId: "qa-01",
      baseAgentId: "qa-01",
      role: "qa",
      task: "Test login flow",
      mode: "web",
      state: "succeeded",
      workerState: "succeeded",
      doneContract: createDoneContract("qa", "web", "Test login flow"),
      verification: {
        planPath: ".openteam/verification-plan.json",
        plan: {...verificationPlan, mode: "web"},
        results: [browserEvidence()],
      },
    })
    const evaluation = evaluateRunRecord(record, {
      finalResponseText: [
        "Scope: login flow.",
        "Environment: local web run.",
        "Evidence: browser screenshot and console observations.",
        "Findings: pass.",
        "Handoff: no handoff",
      ].join("\n"),
    })

    expect(evaluation.ok).toBe(false)
    expect(evaluation.finalResponse?.missingLabels).toEqual(["Verdict"])
    expect(evaluation.failures.map(item => item.code)).toContain("final-response-contract-missing-labels")
  })

  test("skips active run records", () => {
    const evaluation = evaluateRunRecord(runRecord({state: "running"}))

    expect(evaluation.terminal).toBe(false)
    expect(evaluation.ok).toBe(false)
    expect(evaluation.score).toBe(0)
    expect(evaluation.findings.map(item => item.code)).toContain("active-run-skipped")
  })

  test("runs eval command prints structured JSON with response-file scoring", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-run-eval-"))
    const testApp = app(runtimeRoot)
    const record = withRunFile(runRecord({
      state: "succeeded",
      verification: {
        planPath: ".openteam/verification-plan.json",
        plan: verificationPlan,
        results: [
          commandEvidence("Reproduced the helper crash before the fix and verified the fixed behavior."),
        ],
      },
    }), runtimeRoot)
    const responseFile = path.join(runtimeRoot, "final-response.md")
    await writeRun(record)
    await writeFile(responseFile, completeBuilderFinal)

    const output = await captureConsole(() => runsEval(testApp, record.runId, [
      "runs",
      "eval",
      record.runId,
      "--json",
      "--final-response-file",
      responseFile,
    ]))
    const parsed = JSON.parse(output.text)

    expect(parsed.ok).toBe(true)
    expect(parsed.score).toBe(100)
    expect(parsed.finalResponse.available).toBe(true)
    expect(parsed.finalResponse.missingLabels).toEqual([])
  })

  test("runs eval response file overrides stored final response", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-run-eval-"))
    const testApp = app(runtimeRoot)
    const record = withRunFile(runRecord({
      state: "succeeded",
      finalResponse: buildFinalResponseRecord({
        text: [
          "Summary: changed the helper.",
          "Changed Files: src/helper.ts",
          "Publication Readiness: blocked",
          "Blockers: missing verification labels.",
        ].join("\n"),
      }),
      verification: {
        planPath: ".openteam/verification-plan.json",
        plan: verificationPlan,
        results: [
          commandEvidence("Reproduced the helper crash before the fix and verified the fixed behavior."),
        ],
      },
    }), runtimeRoot)
    const responseFile = path.join(runtimeRoot, "final-response.md")
    await writeRun(record)
    await writeFile(responseFile, completeBuilderFinal)

    const output = await captureConsole(() => runsEval(testApp, record.runId, [
      "runs",
      "eval",
      record.runId,
      "--json",
      "--final-response-file",
      responseFile,
    ]))
    const parsed = JSON.parse(output.text)

    expect(parsed.ok).toBe(true)
    expect(parsed.finalResponse.source).toBe("operator-file")
    expect(parsed.finalResponse.missingLabels).toEqual([])
  })

  test("runs eval command prints compact human output and warns without final response text", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "openteam-run-eval-"))
    const testApp = app(runtimeRoot)
    const record = withRunFile(runRecord(), runtimeRoot)
    await writeRun(record)

    const output = await captureConsole(() => runsEval(testApp, record.runId, [
      "runs",
      "eval",
      record.runId,
    ]))

    expect(output.text).toContain(`run: ${record.runId}`)
    expect(output.text).toContain("eval: ok")
    expect(output.text).toContain("score:")
    expect(output.text).toContain("evidence: none")
    expect(output.text).toContain("final response: unavailable")
    expect(output.text).toContain("warning: final-response-unavailable")
    expect(output.text).toContain("missing:")
    expect(output.result.ok).toBe(true)
  })
})
