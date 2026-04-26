const allowedDuringProvision = new Set(["doctor", "status", "console", "prepare", "runs", "browser", "repo", "relay", "profile", "tokens", "git"])
const blockedDuringProvision = new Set(["launch", "enqueue", "serve", "worker"])

export const assertControlAllowed = (cmd: string) => {
  if (process.env.OPENTEAM_PHASE !== "provision") return
  if (blockedDuringProvision.has(cmd) || !allowedDuringProvision.has(cmd)) {
    throw new Error("worker-control commands are disabled during repository provisioning")
  }
}
