const roleContracts: Record<string, Array<[string, string]>> = {
  researcher: [
    ["Findings", "concise answer to the research question with repo references"],
    ["Risks", "implementation, compatibility, security, UX, or operational risks"],
    ["Evidence", "files, commands, events, docs, or observations used"],
    ["Recommendation", "recommended next action"],
    ["Handoff", "next worker role and concrete task prompt, or `no handoff`"],
  ],
  triager: [
    ["Classification", "bug, feature request, support, duplicate, invalid, needs-info, or other local category"],
    ["Reproduction", "reproduced, not reproduced, not attempted, or blocked, with reason"],
    ["Severity", "critical, high, medium, low, or unclear"],
    ["Evidence", "commands, browser observations, repo events, screenshots, or logs"],
    ["Route", "builder, QA, researcher, operator question, or no action"],
    ["Handoff", "concrete next task when a worker should continue, or `no handoff`"],
  ],
  builder: [
    ["Summary", "what changed and why"],
    ["Changed Files", "files touched or intentionally left untouched"],
    ["Verification", "exact checks run or evidence recorded"],
    ["Evidence Level", "strong, weak, failed, blocked, or missing"],
    ["Publication Readiness", "PR eligible, draft-only, blocked, or not applicable"],
    ["Blockers", "concrete blocker, or `none`"],
  ],
  qa: [
    ["Scope", "flows, issue, PR, or behavior tested"],
    ["Environment", "URL, mode, browser profile context, or reason browser was not used"],
    ["Evidence", "screenshots, browser observations, console/network notes, commands, or manual evidence"],
    ["Findings", "pass, fail, regression, inconclusive, or blocked"],
    ["Verdict", "ship, do not ship, needs builder, needs researcher, or needs operator input"],
    ["Handoff", "concrete next task when follow-up is needed, or `no handoff`"],
  ],
  orchestrator: [
    ["Status", "current operational state, not launch optimism"],
    ["Worker", "launched or inspected worker/run id when applicable"],
    ["Role/Mode", "selected role and mode when applicable"],
    ["Target", "resolved target or blocker"],
    ["Evidence", "run, browser, diagnosis, or evidence command used to support the report"],
    ["Next", "one concrete next command or operator decision"],
  ],
}

export const roleOutputContractLines = (role: string) => {
  const contract = roleContracts[role] ?? []
  if (contract.length === 0) return []

  return [
    "Final response contract: use these exact labels and keep each section concise.",
    ...contract.map(([label, description]) => `- \`${label}\`: ${description}`),
  ]
}

export const roleOutputContractLabels = (role: string) =>
  (roleContracts[role] ?? []).map(([label]) => label)

export const roleOutputContractPlainLines = (role: string) =>
  roleOutputContractLines(role).map(line => line.replaceAll("`", ""))
