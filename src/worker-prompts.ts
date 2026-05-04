import {doneContractPromptLines} from "./done-contract.js"
import {gitCollaborationVocabularyLines} from "./git-vocabulary.js"
import {canUseOpencodeHelperAgents, workerProfilePromptLines} from "./model-profiles.js"
import {graspServers} from "./nostr.js"
import {opencodeHelperAgentPromptLines} from "./opencode-agents.js"
import {projectProfilePromptLines, type ProjectProfile} from "./project-profile.js"
import type {RepoRelayPolicy} from "./repo.js"
import {roleOutputContractLines} from "./role-contracts.js"
import {continuationPromptLines} from "./run-continuation.js"
import {subjectPromptLines} from "./subject.js"
import type {PreparedAgent, ResolvedTaskSubject, TaskItem, TaskRunRecord} from "./types.js"

export {roleOutputContractLines} from "./role-contracts.js"

export type WorkerPromptRuntime = {
  bunker?: {
    uri: string
  }
}

const repoRelayContext = (policy?: RepoRelayPolicy, defaultPublishScope = "repo") => {
  if (!policy) return []
  return [
    `Repository relay policy: ${policy.isGrasp ? "GRASP" : "non-GRASP"}`,
    `Repository workflow relays: ${policy.repoRelays.join(", ") || "none"}`,
    `Repository publish relays: ${policy.publishRelays.join(", ") || "none"}`,
    `Repository publish helper default scope: ${defaultPublishScope}`,
    `Repository policy helper: openteam repo policy`,
    `Repository publish helper: openteam repo publish <issue|comment|label|role-label|status|pr|pr-update|raw>`,
  ]
}

const workerSafetyLines = () => [
  `The repository environment has been provisioned by the orchestrator before handoff. Start cleanly from the prepared repo context.`,
  `Use checkout-local scratch space such as .openteam/tmp for repro clones or temporary files; avoid /tmp unless the operator explicitly grants broader filesystem access.`,
  `Use OPENTEAM_TMP_DIR, OPENTEAM_CACHE_DIR, and OPENTEAM_ARTIFACTS_DIR for temporary files, caches, repro clones, and generated evidence.`,
  `Do not run GUI openers, system package installs, or writes outside the managed checkout/runtime. Stop with a concrete blocker when those are required.`,
  `Do not run destructive cleanup such as broad rm -rf or git reset --hard unless the task explicitly requires it and the scope is clear.`,
  `If the environment still appears broken, stop with a concrete blocker instead of trying to redesign provisioning yourself.`,
  `Do not inspect or reason about orchestrator runtime internals such as stale-run cleanup, worker stopping, continuation gates, repo-context lease release, or runtime/runs history. The orchestrator owns those decisions and will provide any sanitized context you need inside the checkout.`,
  `Do not ask interactive questions during unattended worker execution. If a human decision is required, stop with a concrete blocker and the exact decision needed.`,
  `Operator task-status DMs are handled by openteam runtime; focus on the task itself unless the task explicitly requires Nostr messaging work.`,
]

const verificationInstructionLines = (input: {mode: "code" | "web"; url?: string}) => {
  const base = input.mode === "web"
    ? [
      `Verification tools: run \`openteam verify list\` to inspect available capabilities, \`openteam verify run <runner-id>\` for configured local command/native checks, \`openteam verify browser --flow "..." --url "${input.url ?? ""}" --screenshot <path>\` for browser evidence, and \`openteam verify record <runner-id> --state succeeded --note "..."\` for GUI/Nostr/live-data evidence.`,
      `Use the browser MCP if available to verify UI behavior before you claim success.`,
      `When you use browser, desktop, mobile, Nostr, or repo-native verification, record concise evidence through \`openteam verify record\` or \`openteam verify run\` before returning success.`,
    ]
    : [
      `Verification tools: run \`openteam verify list\` to inspect available capabilities, \`openteam verify run <runner-id>\` for configured local command/native checks, \`openteam verify record <runner-id> --type <browser|nostr|desktop|mobile|manual> --state succeeded --note "..."\` for structured agentic evidence, and \`openteam verify artifact <path> --type <type>\` for artifacts.`,
      `When you use repo-native, desktop, mobile, Nostr, or other verification, record concise evidence through \`openteam verify record\` or \`openteam verify run\` before returning success.`,
    ]

  return [
    ...base,
    `If evidence is missing or weak, the run will finish as needs-review; continue verification or report a concrete blocker rather than claiming complete success.`,
  ]
}

const publicationInstructionLines = () => [
  `For branch publication, use plain git against the configured origin and publish Nostr-git PR events through openteam repo publish pr; normal PR publication is blocked until evidence is strong, and you must not rely on gh auth or personal forge sessions.`,
  `When publishing a Nostr-git PR, do not pass the worker/source branch as --branch; use --target-branch only for the merge target branch when needed. The helper infers source fork clone URLs from the repo context.`,
  `For submodule changes, publish PRs against the top-level owner-announced submodule repo whose clone URL matches .gitmodules; the PR source clone must be an openteam-controlled fork that advertises the tip, and deleted-only matches block PR publication.`,
]

const taskManifestLines = () => [
  `Structured task manifest: .openteam/task.json`,
  `Read .openteam/task.json before starting; it is the canonical structured handoff for run facts, done contract, verification plan, and publication policy.`,
]

export const buildProvisioningPrompt = (
  agent: PreparedAgent,
  task: string,
  projectProfile?: ProjectProfile,
  subject?: ResolvedTaskSubject,
) => {
  return [
    `You are ${agent.id}, a ${agent.meta.role} worker in openteam.`,
    `Read the attached bootstrap files first and follow them.`,
    `You are running in provisioning mode, not orchestration mode.`,
    ...taskManifestLines(),
    ...projectProfilePromptLines(projectProfile),
    ...subjectPromptLines(subject),
    `Before any worker is allowed to begin product work, you must make sure this repository environment is capable of fulfilling the requested task.`,
    `Inspect project documentation, lockfiles, workspace files, submodule configuration, and development instructions before choosing commands.`,
    `Provision the environment if needed: initialize submodules, install dependencies, and run the minimum setup needed to make the repository workable.`,
    `Do not assume any specific framework or package manager. Detect what the repository actually uses.`,
    `If the checkout has a Nix flake or shell, openteam will launch you inside that declared development environment; use repo-native commands normally from there.`,
    `For Nix-managed checkouts, openteam also puts checkout-local tool shims in .openteam/bin first on PATH so plain commands such as pnpm, node, and playwright resolve through the declared environment.`,
    `For non-Nix Node checkouts, openteam may put checkout-local package-manager shims in .openteam/bin so pnpm/yarn can fall back through corepack when the host binary is not installed.`,
    ...gitCollaborationVocabularyLines(),
    `Do not attempt browser verification until the environment is ready for it.`,
    `Use checkout-local scratch/cache/artifact paths from OPENTEAM_TMP_DIR, OPENTEAM_CACHE_DIR, and OPENTEAM_ARTIFACTS_DIR; avoid /tmp and host-global caches.`,
    `Do not run GUI openers, system package installs, or writes outside the managed checkout/runtime. Stop with a concrete blocker when those are required.`,
    `Do not run destructive cleanup such as broad rm -rf or git reset --hard unless the task explicitly requires it and the scope is clear.`,
    `Do not launch, enqueue, start, stop, or watch worker agents. Do not call openteam launch, openteam enqueue, openteam serve, or openteam worker.`,
    `Worker handoff target task: ${task}`,
    `When provisioning is complete, leave the managed repo context ready for the worker handoff. If blocked, stop with a concrete blocker.`,
  ].join("\n")
}

export const buildWebWorkerPrompt = (
  agent: PreparedAgent,
  task: string,
  url: string,
  runtime?: WorkerPromptRuntime,
  repoPolicy?: RepoRelayPolicy,
  defaultPublishScope = "repo",
  devEnv?: {kind: string; source?: string},
  projectProfile?: ProjectProfile,
  doneContract?: TaskRunRecord["doneContract"],
  continuation?: TaskItem["continuation"],
  subject?: ResolvedTaskSubject,
) => {
  const grasp = graspServers(agent)
  return [
    `You are ${agent.id}, a ${agent.meta.role} worker in openteam.`,
    `Read the attached bootstrap files first and follow them.`,
    `Target repo: ${agent.meta.repo}`,
    `Local app URL: ${url}`,
    runtime?.bunker?.uri
      ? `Remote signer bunker URL: ${runtime.bunker.uri}`
      : `Remote signer bunker URL: unavailable`,
    grasp.length > 0 ? `Configured GRASP relays: ${grasp.join(", ")}` : `Configured GRASP relays: none`,
    `Detected repo dev environment: ${devEnv?.kind ?? "none"}${devEnv?.source ? ` (${devEnv.source})` : ""}`,
    ...taskManifestLines(),
    ...projectProfilePromptLines(projectProfile),
    ...subjectPromptLines(subject),
    ...doneContractPromptLines(doneContract),
    ...continuationPromptLines(continuation),
    ...workerProfilePromptLines(agent),
    ...gitCollaborationVocabularyLines(),
    ...repoRelayContext(repoPolicy, defaultPublishScope),
    ...(canUseOpencodeHelperAgents(agent) ? opencodeHelperAgentPromptLines(agent.meta.role) : []),
    ...roleOutputContractLines(agent.meta.role),
    `Task: ${task}`,
    ...workerSafetyLines(),
    ...verificationInstructionLines({mode: "web", url}),
    ...publicationInstructionLines(),
    `If the target app requires login, use the Remote Signer flow with the bunker URL above when appropriate.`,
    `Keep working until the task is handled end-to-end or you hit a concrete blocker.`,
  ].join("\n")
}

export const buildCodeWorkerPrompt = (
  agent: PreparedAgent,
  task: string,
  repoPolicy?: RepoRelayPolicy,
  defaultPublishScope = "repo",
  devEnv?: {kind: string; source?: string},
  projectProfile?: ProjectProfile,
  doneContract?: TaskRunRecord["doneContract"],
  continuation?: TaskItem["continuation"],
  subject?: ResolvedTaskSubject,
) => {
  return [
    `You are ${agent.id}, a ${agent.meta.role} worker in openteam.`,
    `Read the attached bootstrap files first and follow them.`,
    ...gitCollaborationVocabularyLines(),
    ...repoRelayContext(repoPolicy, defaultPublishScope),
    `Detected repo dev environment: ${devEnv?.kind ?? "none"}${devEnv?.source ? ` (${devEnv.source})` : ""}`,
    ...taskManifestLines(),
    ...projectProfilePromptLines(projectProfile),
    ...subjectPromptLines(subject),
    ...doneContractPromptLines(doneContract),
    ...continuationPromptLines(continuation),
    ...workerProfilePromptLines(agent),
    ...(canUseOpencodeHelperAgents(agent) ? opencodeHelperAgentPromptLines(agent.meta.role) : []),
    ...roleOutputContractLines(agent.meta.role),
    `Task: ${task}`,
    `This run is code-first, not browser-first. Do not assume a dev server or browser is required unless the task proves otherwise.`,
    ...workerSafetyLines(),
    ...verificationInstructionLines({mode: "code"}),
    ...publicationInstructionLines(),
    `Keep working until the task is handled end-to-end or you hit a concrete blocker.`,
  ].join("\n")
}
