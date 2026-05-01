import {describe, expect, test} from "bun:test"
import {mkdtemp, readFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {createDoneContract} from "../../src/done-contract.js"
import {evaluateEvidencePolicy, prPublicationDecision} from "../../src/evidence-policy.js"
import {scoreRoleFinalResponseFixture, type RoleFinalResponseFixture} from "../../src/eval-fixtures.js"
import {parseOperatorRequest} from "../../src/orchestrator.js"
import {opencodePrimaryAgentPath, writeOpencodeManagedAgents} from "../../src/opencode-agents.js"
import {buildCodeWorkerPrompt} from "../../src/worker-prompts.js"
import type {AppCfg, PreparedAgent, VerificationRunnerResult} from "../../src/types.js"

const app = (patch: Partial<AppCfg["config"]> = {}): AppCfg => ({
  root: "/repo",
  config: {
    runtimeRoot: "/repo/runtime",
    opencode: {binary: "opencode", model: "", agent: "build", roleAgents: true},
    browser: {
      headless: false,
      mcp: {name: "playwright", command: [], environment: {}},
    },
    providers: {},
    repos: {
      app: {
        root: "/repo/app",
        baseBranch: "main",
        sharedPaths: [],
        mode: "code",
      },
    },
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
    workerProfiles: {
      builder: {
        canEdit: true,
        canPublishPr: true,
        canUseBrowser: true,
        canSpawnSubagents: true,
        requiresEvidence: true,
      },
      researcher: {
        canEdit: false,
        canPublishPr: false,
        canUseBrowser: false,
        canSpawnSubagents: true,
        requiresEvidence: false,
      },
    },
    agents: {},
    ...patch,
  },
})

const prepared = (role: string, testApp = app()): PreparedAgent => ({
  app: testApp,
  id: `${role}-01`,
  configId: `${role}-01`,
  meta: {
    id: `${role}-01`,
    role,
    soul: role,
    repo: "app",
    description: "",
    capabilities: [],
  },
  agent: {
    role,
    soul: role,
    repo: "app",
    portStart: 18471,
    reporting: {},
    identity: {npub: "", sec: "secret", bunkerProfile: `${role}-01`, nakClientKey: ""},
  },
  repo: testApp.config.repos.app,
  paths: {
    root: `/repo/runtime/agents/${role}-01`,
    workspace: `/repo/runtime/agents/${role}-01/workspace`,
    memory: `/repo/runtime/agents/${role}-01/workspace/memory`,
    tasks: `/repo/runtime/agents/${role}-01/tasks`,
    queue: `/repo/runtime/agents/${role}-01/tasks/queue`,
    history: `/repo/runtime/agents/${role}-01/tasks/history`,
    artifacts: `/repo/runtime/agents/${role}-01/artifacts`,
    browser: `/repo/runtime/agents/${role}-01/browser`,
    stateFile: `/repo/runtime/agents/${role}-01/state.json`,
  },
})

const commandEvidence = (note = "Validated behavior with repo-native checks."): VerificationRunnerResult => ({
  id: "repo-native",
  kind: "command",
  evidenceType: "repo-native",
  state: "succeeded",
  source: "worker",
  command: ["bun", "test"],
  logFile: ".openteam/artifacts/verification/repo-native.log",
  note,
})

const browserEvidence = (note = "Verified the visible UI flow in browser."): VerificationRunnerResult => ({
  id: "browser",
  kind: "playwright-mcp",
  evidenceType: "browser",
  state: "succeeded",
  source: "worker",
  screenshots: [".openteam/artifacts/browser/dashboard.png"],
  note,
})

describe("phase 5 deterministic product evals", () => {
  test("orchestrator routing fixtures classify explicit operator commands", () => {
    const cases = [
      {
        input: "work on nostr://npub1example/repo as researcher in code mode with model openai/gpt-5.4 in parallel and do compare implementation options",
        expected: {
          kind: "work",
          target: "nostr://npub1example/repo",
          role: "researcher",
          mode: "code",
          model: "openai/gpt-5.4",
          parallel: true,
          task: "compare implementation options",
        },
      },
      {
        input: "research 30617:abc:repo and identify safest fix direction",
        expected: {
          kind: "research",
          target: "30617:abc:repo",
          role: "researcher",
          mode: "code",
          model: undefined,
          parallel: false,
          task: "identify safest fix direction",
        },
      },
      {
        input: "plan 30617:abc:repo in web mode and produce a builder handoff",
        expected: {
          kind: "research",
          target: "30617:abc:repo",
          role: "researcher",
          mode: "web",
          model: undefined,
          parallel: false,
          task: "Produce a research-backed implementation plan: produce a builder handoff",
        },
      },
      {
        input: "watch repo in code mode",
        expected: {
          kind: "watch",
          target: "repo",
          role: "triager",
          mode: "code",
          model: undefined,
        },
      },
    ]

    for (const item of cases) {
      expect(parseOperatorRequest(item.input)).toEqual(item.expected)
    }
    expect(parseOperatorRequest("can someone look at this?")).toBeUndefined()
  })

  test("evidence fixtures preserve worker completion and publication safety gates", () => {
    const cases = [
      {
        name: "builder code fix with no evidence",
        contract: createDoneContract("builder", "code", "Fix helper crash"),
        results: [],
        level: "none",
        finalState: "needs-review",
        prEligible: false,
        normalPr: false,
      },
      {
        name: "builder code fix with repo-native evidence",
        contract: createDoneContract("builder", "code", "Fix helper crash"),
        results: [commandEvidence("Implemented the helper fix and verified the failing behavior no longer reproduces.")],
        level: "strong",
        finalState: "succeeded",
        prEligible: true,
        normalPr: true,
      },
      {
        name: "web UI work with command-only evidence",
        contract: createDoneContract("builder", "web", "Fix dashboard UI contrast"),
        results: [commandEvidence()],
        level: "weak",
        finalState: "needs-review",
        prEligible: false,
        normalPr: false,
      },
      {
        name: "web UI work with browser and repo-native evidence",
        contract: createDoneContract("builder", "web", "Fix dashboard UI contrast"),
        results: [browserEvidence(), commandEvidence()],
        level: "strong",
        finalState: "succeeded",
        prEligible: true,
        normalPr: true,
      },
      {
        name: "research report with substantive note",
        contract: createDoneContract("researcher", "code", "Research dependency risk"),
        results: [{
          id: "research-note",
          kind: "command",
          state: "succeeded",
          source: "worker",
          note: "Question answered; inspected package metadata and repo files. Risks and builder handoff included.",
        }],
        level: "strong",
        finalState: "succeeded",
        prEligible: false,
        normalPr: false,
      },
    ]

    for (const item of cases) {
      const policy = evaluateEvidencePolicy(item.contract, item.results as VerificationRunnerResult[])
      expect(policy.level).toBe(item.level)
      expect(policy.finalStateForSuccessfulWorker).toBe(item.finalState)
      expect(policy.prEligible).toBe(item.prEligible)
      expect(prPublicationDecision(policy).allowed).toBe(item.normalPr)
    }

    const failed = evaluateEvidencePolicy(createDoneContract("builder", "code", "Fix helper crash"), [{
      id: "repo-native",
      kind: "command",
      evidenceType: "repo-native",
      state: "failed",
      source: "worker",
      error: "bun test failed",
    }])

    expect(failed.level).toBe("failed")
    expect(failed.prEligible).toBe(false)
    expect(prPublicationDecision(failed).allowed).toBe(false)
    expect(prPublicationDecision(failed, {draft: true}).allowed).toBe(true)
  })

  test("role final-response fixtures catch missing output-contract labels", () => {
    const fixtures: RoleFinalResponseFixture[] = [
      {
        name: "complete builder response",
        role: "builder",
        ok: true,
        text: [
          "Summary: fixed the helper crash.",
          "Changed Files: src/helper.ts",
          "Verification: bun test tests/helper.test.ts",
          "Evidence Level: strong",
          "Publication Readiness: PR eligible",
          "Blockers: none",
        ].join("\n"),
      },
      {
        name: "builder response missing verification fields",
        role: "builder",
        ok: false,
        missingLabels: ["Verification", "Evidence Level"],
        text: [
          "Summary: fixed the helper crash.",
          "Changed Files: src/helper.ts",
          "Publication Readiness: blocked",
          "Blockers: missing checks",
        ].join("\n"),
      },
      {
        name: "complete researcher response",
        role: "researcher",
        ok: true,
        text: [
          "Findings: the safer path is a focused parser fix.",
          "Risks: broad refactor would touch unrelated flows.",
          "Evidence: inspected src/parser.ts and tests/parser.test.ts.",
          "Recommendation: send builder a focused fix task.",
          "Handoff: builder: fix parser edge case and run parser tests.",
        ].join("\n"),
      },
      {
        name: "qa response missing verdict",
        role: "qa",
        ok: false,
        missingLabels: ["Verdict"],
        text: [
          "Scope: login flow.",
          "Environment: local web run.",
          "Evidence: browser screenshot and console check.",
          "Findings: password reset regressed.",
          "Handoff: builder: inspect reset route.",
        ].join("\n"),
      },
    ]

    for (const fixture of fixtures) {
      const score = scoreRoleFinalResponseFixture(fixture)
      expect(score.ok).toBe(fixture.ok)
      expect(score.matchesExpectation).toBe(true)
    }
  })

  test("prompt and opencode-agent fixtures preserve role policy layering", async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), "openteam-phase5-evals-"))
    await writeOpencodeManagedAgents(prepared("builder"), checkout)

    const builderPrimary = await readFile(opencodePrimaryAgentPath(checkout, "builder"), "utf8")
    const researcherPrimary = await readFile(opencodePrimaryAgentPath(checkout, "researcher"), "utf8")
    const builderPrompt = buildCodeWorkerPrompt(
      prepared("builder"),
      "fix the helper crash",
      undefined,
      "repo",
      undefined,
      undefined,
      createDoneContract("builder", "code", "fix the helper crash"),
    )

    expect(builderPrimary).toContain("mode: primary")
    expect(builderPrimary).toContain("Role policy: implement focused code changes")
    expect(builderPrimary).toContain("Final response contract")
    expect(builderPrimary).toContain("- Publication Readiness:")
    expect(researcherPrimary).toContain("edit: deny")
    expect(researcherPrimary).toContain(`"*": deny`)
    expect(researcherPrimary).toContain(`"openteam verify *": allow`)
    expect(researcherPrimary).toContain("Do not modify product source")
    expect(builderPrompt).toContain("Structured task manifest: .openteam/task.json")
    expect(builderPrompt).toContain("Done contract:")
    expect(builderPrompt).toContain("Opencode helper subagents available through the Task tool")
    expect(builderPrompt).toContain("Final response contract")
  })
})
