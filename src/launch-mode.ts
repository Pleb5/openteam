import type {TaskMode} from "./types.js"

type LaunchRole = "builder" | "triager" | "qa" | "researcher" | "orchestrator" | string

export type LaunchExecutionMode = {
  detached: boolean
  explicit: boolean
  reason: string
}

const workerRoles = new Set(["builder", "triager", "qa", "researcher"])

const isInternalDetachedLaunch = (env: NodeJS.ProcessEnv) => env.OPENTEAM_INTERNAL_DETACHED_LAUNCH === "1"

export const isNonInteractiveLaunchContext = (input: {
  stdinIsTTY?: boolean
  stdoutIsTTY?: boolean
  env?: NodeJS.ProcessEnv
}) => {
  const env = input.env ?? process.env
  return (
    input.stdinIsTTY === false ||
    input.stdoutIsTTY === false ||
    Boolean(
      env.OPENCODE_SESSION ||
      env.OPENCODE_CALL_ID ||
      env.OPENCODE_TOOL_CALL_ID ||
      env.OPENCLAW_SESSION ||
      env.OPENTEAM_OPENCODE_CONTEXT ||
      env.OPENTEAM_OPENCODE_STATE_DIR ||
      env.OPENTEAM_OPENCODE_ATTEMPT,
    )
  )
}

export const resolveLaunchExecutionMode = (input: {
  args: string[]
  role: LaunchRole
  mode?: TaskMode
  stdinIsTTY?: boolean
  stdoutIsTTY?: boolean
  env?: NodeJS.ProcessEnv
}): LaunchExecutionMode => {
  const env = input.env ?? process.env
  const wantsDetach = input.args.includes("--detach")
  const wantsAttach = input.args.includes("--attach")
  if (wantsDetach && wantsAttach) {
    throw new Error("choose only one of --detach or --attach")
  }
  if (wantsDetach) {
    return {detached: true, explicit: true, reason: "--detach requested"}
  }
  if (wantsAttach) {
    if (workerRoles.has(input.role) && isNonInteractiveLaunchContext({...input, env}) && !isInternalDetachedLaunch(env)) {
      throw new Error("--attach is not allowed for worker launches from managed or non-interactive OpenCode contexts; use --detach and inspect with openteam runs")
    }
    return {detached: false, explicit: true, reason: "--attach requested"}
  }

  if (workerRoles.has(input.role) && isNonInteractiveLaunchContext({...input, env})) {
    return {
      detached: true,
      explicit: false,
      reason: "non-interactive worker launch defaults to detached to survive caller tool timeouts",
    }
  }

  return {detached: false, explicit: false, reason: "interactive launch defaults to attached"}
}
