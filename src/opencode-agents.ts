import {mkdir, writeFile} from "node:fs/promises"
import path from "node:path"
import {resolveWorkerProfile} from "./model-profiles.js"
import {roleOutputContractPlainLines} from "./role-contracts.js"
import type {PreparedAgent, WorkerProfileCfg} from "./types.js"

export type OpencodeHelperAgent = {
  name: string
  description: string
  body: string
}

export type OpencodePrimaryRole = "builder" | "researcher" | "qa" | "triager" | "orchestrator"

type WorkerCapabilities = Required<Pick<
  WorkerProfileCfg,
  "canEdit" | "canPublishPr" | "canUseBrowser" | "canSpawnSubagents" | "requiresEvidence"
>>

const clean = (value?: string) => value?.trim() || undefined

export const openteamPrimaryRoles: OpencodePrimaryRole[] = [
  "builder",
  "researcher",
  "qa",
  "triager",
  "orchestrator",
]

export const opencodePrimaryAgentName = (role: string) =>
  openteamPrimaryRoles.includes(role as OpencodePrimaryRole)
    ? `openteam-${role}`
    : undefined

const defaultCapabilities: Record<OpencodePrimaryRole, WorkerCapabilities> = {
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
  qa: {
    canEdit: false,
    canPublishPr: false,
    canUseBrowser: true,
    canSpawnSubagents: true,
    requiresEvidence: true,
  },
  triager: {
    canEdit: false,
    canPublishPr: false,
    canUseBrowser: false,
    canSpawnSubagents: true,
    requiresEvidence: true,
  },
  orchestrator: {
    canEdit: false,
    canPublishPr: false,
    canUseBrowser: false,
    canSpawnSubagents: false,
    requiresEvidence: false,
  },
}

const workerProfileForRole = (agent: PreparedAgent, role: OpencodePrimaryRole) =>
  agent.agent.role === role
    ? resolveWorkerProfile(agent).profile
    : agent.app.config.workerProfiles?.[role]

const capabilitiesForRole = (agent: PreparedAgent, role: OpencodePrimaryRole): WorkerCapabilities => {
  const profile = workerProfileForRole(agent, role)
  return {
    ...defaultCapabilities[role],
    ...Object.fromEntries(
      Object.entries({
        canEdit: profile?.canEdit,
        canPublishPr: profile?.canPublishPr,
        canUseBrowser: profile?.canUseBrowser,
        canSpawnSubagents: profile?.canSpawnSubagents,
        requiresEvidence: profile?.requiresEvidence,
      }).filter(([, value]) => value !== undefined),
    ),
  } as WorkerCapabilities
}

export const selectOpencodePrimaryAgent = (agent: PreparedAgent) => {
  const worker = resolveWorkerProfile(agent)
  const explicit = clean(agent.agent.opencodeAgent) ?? clean(worker.profile?.opencodeAgent)
  if (explicit) return explicit

  if (agent.app.config.opencode.roleAgents === true) {
    const generated = opencodePrimaryAgentName(agent.agent.role)
    if (generated) return generated
  }

  return clean(agent.app.config.opencode.agent) ?? "build"
}

const readOnlyPermission = [
  `permission:`,
  `  "*": deny`,
  `  read: allow`,
  `  glob: allow`,
  `  grep: allow`,
  `  list: allow`,
  `  webfetch: allow`,
  `  websearch: allow`,
].join("\n")

const yamlKey = (key: string) =>
  /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : JSON.stringify(key)

const renderPermission = (rules: Record<string, string | Record<string, string>>) => {
  const lines = [`permission:`]
  for (const [permission, value] of Object.entries(rules)) {
    if (typeof value === "string") {
      lines.push(`  ${yamlKey(permission)}: ${value}`)
      continue
    }
    lines.push(`  ${yamlKey(permission)}:`)
    for (const [pattern, action] of Object.entries(value)) {
      lines.push(`    ${yamlKey(pattern)}: ${action}`)
    }
  }
  return lines.join("\n")
}

const primaryPermission = (role: OpencodePrimaryRole, capabilities: WorkerCapabilities) => {
  const rules: Record<string, string | Record<string, string>> = {
    question: role === "orchestrator" ? "allow" : "deny",
    plan_enter: "allow",
  }

  if (!capabilities.canEdit) {
    rules.edit = "deny"
  }

  if (!capabilities.canSpawnSubagents) {
    rules.task = "deny"
  }

  const bash: Record<string, string> = {}
  if (!capabilities.canEdit) {
    bash["*"] = "deny"
    bash["openteam verify *"] = "allow"
    bash["./scripts/openteam verify *"] = "allow"
    bash["openteam repo policy *"] = "allow"
    bash["./scripts/openteam repo policy *"] = "allow"
  }
  if (!capabilities.canPublishPr) {
    bash["openteam repo publish pr*"] = "deny"
    bash["./scripts/openteam repo publish pr*"] = "deny"
    bash["git push*"] = "deny"
  }
  if (Object.keys(bash).length > 0) {
    rules.bash = bash
  }

  return renderPermission(rules)
}

const rolePolicy = (role: OpencodePrimaryRole) => {
  switch (role) {
    case "builder":
      return [
        `Role policy: implement focused code changes, keep unrelated files untouched, and verify before reporting success.`,
        `Use helper subagents for read-only exploration or review when they materially reduce uncertainty.`,
        `Publish normal PR work only when the evidence gate is strong and the runtime publication policy allows it.`,
      ]
    case "researcher":
      return [
        `Role policy: stay research-first and read-only for product source.`,
        `Do not modify product source, config, lockfiles, tests, branches, commits, or PRs.`,
        `You may record structured openteam verify evidence when it supports the research result.`,
        `Return concrete findings, risks, recommendation, and a handoff rather than making the implementation yourself.`,
      ]
    case "qa":
      return [
        `Role policy: verify behavior, record evidence, and report a verdict.`,
        `Do not implement product changes. Send implementation follow-up to a builder when needed.`,
        `Use browser, command, Nostr, desktop, mobile, or manual evidence only when it matches the run mode and task manifest.`,
      ]
    case "triager":
      return [
        `Role policy: classify incoming work, inspect repo/event context, reproduce only when useful, and route the next action.`,
        `Do not implement product changes. Publish only appropriate triage-side repo events when policy allows it.`,
        `Ask for operator input when severity, target, or requested action is ambiguous.`,
      ]
    case "orchestrator":
      return [
        `Role policy: manage workers and report operational state.`,
        `Do not implement product changes inside the orchestrator session.`,
        `Use openteam worker-control commands only for operator-requested lifecycle work, and keep reports concise.`,
      ]
  }
}

const primaryBody = (role: OpencodePrimaryRole, capabilities: WorkerCapabilities) => [
  `You are openteam-${role}, the primary opencode system agent for an openteam ${role} worker.`,
  ``,
  `This is durable system policy. The runtime prompt and .openteam/task.json provide task-specific facts and must stay within this policy.`,
  `Act as a pragmatic coding agent inside the managed checkout: inspect before acting, prefer repo-local conventions, keep scope tight, run or record appropriate verification, and surface concrete blockers.`,
  `Read attached bootstrap files and .openteam/task.json before starting product work.`,
  `Use OPENTEAM_RUN_ID, OPENTEAM_RUN_FILE, OPENTEAM_TASK_MANIFEST, OPENTEAM_TMP_DIR, OPENTEAM_CACHE_DIR, and OPENTEAM_ARTIFACTS_DIR when relevant.`,
  `Do not launch, enqueue, start, stop, or watch other openteam workers unless this is an orchestrator worker explicitly handling lifecycle control.`,
  role === "orchestrator"
    ? `You may ask concise operator questions when lifecycle policy or operator intent is ambiguous.`
    : `Do not ask interactive questions. If human input is truly required, stop with a concrete blocker in your final response.`,
  role === "orchestrator"
    ? `You own stale-run diagnosis, cleanup, continuation policy, and operator escalation decisions.`
    : `Do not reason about orchestration lifecycle tasks such as stale-run cleanup, worker stopping, continuation gates, or repo-context lease release. Treat those as orchestrator-owned concerns.`,
  ``,
  `Capability policy:`,
  `- canEdit: ${capabilities.canEdit}`,
  `- canPublishPr: ${capabilities.canPublishPr}`,
  `- canUseBrowser: ${capabilities.canUseBrowser}`,
  `- canSpawnSubagents: ${capabilities.canSpawnSubagents}`,
  `- requiresEvidence: ${capabilities.requiresEvidence}`,
  ``,
  ...rolePolicy(role),
  ``,
  ...roleOutputContractPlainLines(role),
  ``,
].join("\n")

const sharedRules = [
  `Common rules:`,
  ``,
  `- Read .openteam/task.json first when it is relevant to the assigned subtask.`,
  `- Stay read-only. Do not edit files, write product artifacts, commit, branch, publish, start servers, or run shell commands.`,
  `- Do not call openteam launch, openteam enqueue, openteam serve, openteam worker, or openteam repo publish.`,
  `- Treat your result as advice to the parent worker. The parent worker owns edits, verification, publication, and the final response.`,
  `- Keep the final answer concise and include concrete files, facts, risks, and recommended next action.`,
].join("\n")

export const opencodeHelperAgents: OpencodeHelperAgent[] = [
  {
    name: "openteam-explore",
    description: "Read-only codebase exploration and architecture mapping for openteam workers.",
    body: [
      `You are openteam-explore, a read-only codebase exploration helper for an openteam worker.`,
      ``,
      `Use this agent when the parent worker needs fast codebase orientation, file discovery, architecture mapping, ownership boundaries, or implementation context before acting.`,
      ``,
      sharedRules,
      ``,
      `Return:`,
      ``,
      `- Findings: the direct answer with file references`,
      `- Map: relevant files, modules, commands, or docs to inspect`,
      `- Risks: uncertainty, coupling, or likely follow-up work`,
      `- Next: one concrete parent-worker action`,
    ].join("\n"),
  },
  {
    name: "openteam-review",
    description: "Read-only patch review, risk scan, and missing-test check for openteam builders.",
    body: [
      `You are openteam-review, a read-only review helper for an openteam worker.`,
      ``,
      `Use this agent after the parent worker has a proposed patch, changed files, or a concrete implementation approach that needs risk review.`,
      ``,
      sharedRules,
      ``,
      `Review priorities:`,
      ``,
      `- behavioral regressions and incorrect assumptions`,
      `- missing or weak verification evidence`,
      `- security, reliability, performance, and compatibility risks`,
      `- scope creep or unrelated edits`,
      `- publication blockers such as weak evidence or unclear target branch`,
      ``,
      `Return findings first, ordered by severity. If there are no material issues, say that clearly and list residual test gaps.`,
    ].join("\n"),
  },
  {
    name: "openteam-qa-flow",
    description: "Read-only QA flow checklist and evidence planning for openteam workers.",
    body: [
      `You are openteam-qa-flow, a read-only QA planning helper for an openteam worker.`,
      ``,
      `Use this agent when the parent worker needs a browser, desktop, mobile, Nostr, or user-flow validation plan before executing verification.`,
      ``,
      sharedRules,
      ``,
      `Focus on:`,
      ``,
      `- user-visible behavior to verify`,
      `- setup assumptions such as URL, auth, data, fixtures, and browser profile`,
      `- console, network, screenshot, command, or Nostr evidence worth recording`,
      `- likely regressions and edge cases`,
      `- whether the verdict should be ship, do not ship, needs builder, or blocked`,
      ``,
      `Return a compact checklist the parent worker can execute and record through openteam verify.`,
    ].join("\n"),
  },
  {
    name: "openteam-dependency",
    description: "Read-only dependency, lockfile, and tooling risk analysis for openteam workers.",
    body: [
      `You are openteam-dependency, a read-only dependency and tooling analysis helper for an openteam worker.`,
      ``,
      `Use this agent when the parent worker needs to understand package managers, lockfiles, workspace layout, dev environment declarations, provisioning blockers, or dependency compatibility risk.`,
      ``,
      sharedRules,
      ``,
      `Inspect repo-local evidence such as package manifests, lockfiles, workspace files, Nix/devenv files, build scripts, CI files, and docs. Use web lookup only when repo-local evidence is insufficient.`,
      ``,
      `Return:`,
      ``,
      `- Tooling: detected package managers, runtimes, workspace shape, and environment declarations`,
      `- Risks: install/build/test blockers or compatibility concerns`,
      `- Evidence: files and facts inspected`,
      `- Next: safest parent-worker command or blocker statement`,
    ].join("\n"),
  },
]

export const opencodeHelperAgentDir = (checkout: string) =>
  path.join(checkout, ".opencode", "agent")

export const opencodeHelperAgentPath = (checkout: string, name: string) =>
  path.join(opencodeHelperAgentDir(checkout), `${name}.md`)

export const opencodePrimaryAgentPath = (checkout: string, role: OpencodePrimaryRole) =>
  path.join(opencodeHelperAgentDir(checkout), `${opencodePrimaryAgentName(role)!}.md`)

const renderHelperAgent = (agent: OpencodeHelperAgent) => [
  `---`,
  `description: ${JSON.stringify(agent.description)}`,
  `mode: subagent`,
  readOnlyPermission,
  `---`,
  ``,
  agent.body,
  ``,
].join("\n")

const renderPrimaryAgent = (
  agent: PreparedAgent,
  role: OpencodePrimaryRole,
) => {
  const capabilities = capabilitiesForRole(agent, role)
  return [
    `---`,
    `description: ${JSON.stringify(`Primary openteam ${role} worker agent with role policy and permissions.`)}`,
    `mode: primary`,
    primaryPermission(role, capabilities),
    `---`,
    ``,
    primaryBody(role, capabilities),
  ].join("\n")
}

export const writeOpencodeHelperAgents = async (checkout: string) => {
  const dir = opencodeHelperAgentDir(checkout)
  await mkdir(dir, {recursive: true})
  const files = await Promise.all(opencodeHelperAgents.map(async agent => {
    const file = opencodeHelperAgentPath(checkout, agent.name)
    await writeFile(file, renderHelperAgent(agent))
    return file
  }))
  return files
}

export const writeOpenteamPrimaryAgents = async (agent: PreparedAgent, checkout: string) => {
  const dir = opencodeHelperAgentDir(checkout)
  await mkdir(dir, {recursive: true})
  const files = await Promise.all(openteamPrimaryRoles.map(async role => {
    const file = opencodePrimaryAgentPath(checkout, role)
    await writeFile(file, renderPrimaryAgent(agent, role))
    return file
  }))
  return files
}

export const writeOpencodeManagedAgents = async (agent: PreparedAgent, checkout: string) => {
  const helpers = await writeOpencodeHelperAgents(checkout)
  const primaries = await writeOpenteamPrimaryAgents(agent, checkout)
  return [...helpers, ...primaries]
}

export const opencodeHelperAgentPromptLines = (role: string) => {
  const roleHint = (() => {
    switch (role) {
      case "builder":
        return "Builder hint: use openteam-explore for unfamiliar code areas and openteam-review before finalizing non-trivial patches."
      case "researcher":
        return "Researcher hint: use openteam-explore for repo architecture and openteam-dependency for tooling or compatibility uncertainty."
      case "qa":
        return "QA hint: use openteam-qa-flow to plan flows and evidence before executing browser or live verification."
      case "triager":
        return "Triager hint: use openteam-explore or openteam-dependency when classification depends on repo context."
      default:
        return "Use helper subagents only when they materially reduce uncertainty."
    }
  })()

  return [
    `Opencode helper subagents available through the Task tool: ${opencodeHelperAgents.map(agent => agent.name).join(", ")}.`,
    `Use helper subagents for tactical read-only analysis only; they do not create openteam run records and their findings must be summarized in your final worker output or verification notes when relevant.`,
    roleHint,
  ]
}
