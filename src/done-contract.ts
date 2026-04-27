import type {DoneContract, TaskMode} from "./types.js"

const hasAny = (value: string, patterns: RegExp[]) => patterns.some(pattern => pattern.test(value))

const taskClassFor = (role: string, mode: TaskMode, task: string): DoneContract["taskClass"] => {
  const text = task.toLowerCase()
  if (role === "researcher") return "research"
  if (role === "triager") return "triage"
  if (role === "qa") return "qa"
  if (mode === "web" || hasAny(text, [/\bui\b/, /\bux\b/, /\bbrowser\b/, /\btheme\b/, /\bcolor\b/, /\bpage\b/, /\bscreen\b/])) return "ui-web"
  if (hasAny(text, [/\bbug\b/, /\bfix\b/, /\brepro/, /\bcrash\b/, /\bfail/])) return "bug-fix"
  if (role === "builder") return "implementation"
  return "general"
}

const contractPieces = (taskClass: DoneContract["taskClass"]) => {
  switch (taskClass) {
    case "bug-fix":
      return {
        requiredEvidence: [
          "reproduction or clear explanation why reproduction was not possible",
          "fix summary and changed scope",
          "repo-native validation command or explicit blocker",
          "regression evidence for the failing behavior",
        ],
        successPolicy: [
          "return success only after the bug is fixed or conclusively not reproducible",
          "record failed or blocked evidence if validation cannot be completed",
        ],
        prPolicy: "publish PR only after successful verification evidence exists; otherwise leave local state and report blocker/risk",
      }
    case "ui-web":
      return {
        requiredEvidence: [
          "browser flow tested with visible expected behavior",
          "console/network observations when relevant",
          "repo-native check or explicit blocker",
          "artifact path or note for screenshots/session/logs when useful",
        ],
        successPolicy: [
          "trust browser evidence over code assumptions",
          "return success only after visible behavior was checked",
        ],
        prPolicy: "publish PR only after browser or equivalent UI evidence is recorded",
      }
    case "triage":
      return {
        requiredEvidence: [
          "issue/event/thread inspected",
          "reproduction status",
          "severity/routing recommendation",
          "repo-visible comment/label/status when requested",
        ],
        successPolicy: [
          "return success with a clear routing outcome or explicit uncertainty",
          "do not invent implementation fixes",
        ],
        prPolicy: "triage normally does not publish PRs",
      }
    case "qa":
      return {
        requiredEvidence: [
          "tested user flow",
          "expected versus actual behavior",
          "browser/GUI/live-data evidence",
          "verdict: pass, fail, flaky, or blocked",
        ],
        successPolicy: [
          "return success only with a clear QA verdict",
          "record failed or blocked evidence when behavior cannot be verified",
        ],
        prPolicy: "QA normally does not publish PRs",
      }
    case "research":
      return {
        requiredEvidence: [
          "question answered or unknowns identified",
          "sources/files/events inspected",
          "risks and tradeoffs",
          "recommended next worker handoff",
        ],
        successPolicy: [
          "return success with a decision memo or explicit unknowns",
          "do not implement unless the operator explicitly changes role/scope",
        ],
        prPolicy: "research does not publish PRs",
      }
    case "implementation":
      return {
        requiredEvidence: [
          "implementation summary",
          "repo-native validation command or explicit blocker",
          "task-specific behavior evidence",
          "PR/event publication status or reason not published",
        ],
        successPolicy: [
          "return success only after implementation and validation evidence are recorded",
          "record residual risks when confidence is not high",
        ],
        prPolicy: "publish PR only after successful verification evidence exists; otherwise leave local state and report blocker/risk",
      }
    default:
      return {
        requiredEvidence: [
          "what was done",
          "how it was checked",
          "artifacts/logs/events when available",
          "risks or blockers",
        ],
        successPolicy: [
          "return success only with evidence-backed confidence",
          "record blocker evidence when verification cannot be completed",
        ],
        prPolicy: "publish only when task completion and verification evidence justify it",
      }
  }
}

export const createDoneContract = (role: string, mode: TaskMode, task: string): DoneContract => {
  const taskClass = taskClassFor(role, mode, task)
  const pieces = contractPieces(taskClass)
  return {
    version: 1,
    role,
    mode,
    taskClass,
    summary: `Done contract for ${role}/${mode} ${taskClass} work`,
    ...pieces,
  }
}

export const doneContractPromptLines = (contract?: DoneContract) => {
  if (!contract) return []
  return [
    `Done contract: ${contract.summary}`,
    `Required evidence: ${contract.requiredEvidence.join("; ")}`,
    `Success policy: ${contract.successPolicy.join("; ")}`,
    `PR policy: ${contract.prPolicy}`,
  ]
}
