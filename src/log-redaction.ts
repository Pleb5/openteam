const secretAssignment = /^([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|SEC|PASSWORD|PRIVATE_KEY|CLIENT_KEY|NAK_CLIENT_KEY)[A-Za-z0-9_]*=).+$/gim
const bearerToken = /(Authorization:\s*Bearer\s+)([^\s"']+)/gi
const githubToken = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g
const gitlabToken = /\bglpat-[A-Za-z0-9_.-]{20,}\b/g
const nsec = /\bnsec1[02-9ac-hj-np-z]{20,}\b/gi

export const redactSensitiveText = (text: string) =>
  text
    .replace(secretAssignment, "$1[REDACTED]")
    .replace(bearerToken, "$1[REDACTED]")
    .replace(githubToken, "[REDACTED_GITHUB_TOKEN]")
    .replace(gitlabToken, "[REDACTED_GITLAB_TOKEN]")
    .replace(nsec, "[REDACTED_NSEC]")
