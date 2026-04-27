import {existsSync} from "node:fs"
import {mkdir, writeFile} from "node:fs/promises"
import {spawnSync, type SpawnSyncOptions, type SpawnSyncReturns} from "node:child_process"
import os from "node:os"
import path from "node:path"
import type {AppCfg} from "../types.js"

type ServiceCommandResult = SpawnSyncReturns<Buffer | string>

export type ServiceCommandRunner = (
  command: string,
  args: string[],
  options?: SpawnSyncOptions,
) => ServiceCommandResult

type ServiceCommandOptions = {
  home?: string
  runner?: ServiceCommandRunner
}

const defaultRunner: ServiceCommandRunner = (command, args, options) =>
  spawnSync(command, args, options)

const serviceName = (agentId = "orchestrator-01") =>
  `openteam-agent@${agentId}.service`

const serviceUserDir = (home: string) =>
  path.join(home, ".config", "systemd", "user")

const unitPath = (home: string, name: string) =>
  path.join(serviceUserDir(home), name)

const unitEscape = (value: string) => value.replace(/%/g, "%%")

const servicePath = "%h/.nix-profile/bin:/nix/var/nix/profiles/default/bin:/run/current-system/sw/bin:/usr/local/bin:/usr/bin:/bin"

export const renderAgentServiceUnit = (root: string) => {
  const escapedRoot = unitEscape(root)
  return `[Unit]
Description=openteam agent %i
After=network-online.target
Wants=network-online.target
PartOf=openteam.target

[Service]
Type=simple
WorkingDirectory=${escapedRoot}
Environment=PATH=${servicePath}
ExecStart=${escapedRoot}/scripts/launch-agent %i
Restart=on-failure
RestartSec=5
TimeoutStopSec=20

[Install]
WantedBy=default.target
`
}

export const renderTargetUnit = () => `[Unit]
Description=openteam agents target
Wants=openteam-agent@orchestrator-01.service

[Install]
WantedBy=default.target
`

const run = (
  runner: ServiceCommandRunner,
  command: string,
  args: string[],
  options: SpawnSyncOptions = {},
) => {
  const result = runner(command, args, options)
  if (result.error) throw result.error
  return result
}

const output = (value?: Buffer | string | null) =>
  value ? value.toString().trim() : ""

const assertOk = (result: ServiceCommandResult, label: string) => {
  if (result.status === 0) return
  const details = output(result.stderr) || output(result.stdout)
  throw new Error(details ? `${label} failed: ${details}` : `${label} failed`)
}

const systemctl = (
  runner: ServiceCommandRunner,
  args: string[],
  options: SpawnSyncOptions = {},
) => run(runner, "systemctl", ["--user", ...args], options)

const journalctl = (
  runner: ServiceCommandRunner,
  args: string[],
  options: SpawnSyncOptions = {},
) => run(runner, "journalctl", ["--user", ...args], options)

export const installServiceUnits = async (
  app: AppCfg,
  options: ServiceCommandOptions = {},
) => {
  const home = options.home ?? os.homedir()
  const dir = serviceUserDir(home)
  const agentUnit = unitPath(home, "openteam-agent@.service")
  const targetUnit = unitPath(home, "openteam.target")

  await mkdir(dir, {recursive: true})
  await writeFile(agentUnit, renderAgentServiceUnit(app.root))
  await writeFile(targetUnit, renderTargetUnit())

  const runner = options.runner ?? defaultRunner
  assertOk(systemctl(runner, ["daemon-reload"], {encoding: "buffer"}), "systemctl daemon-reload")

  return {dir, agentUnit, targetUnit}
}

const requireInstalled = (
  options: ServiceCommandOptions,
) => {
  const home = options.home ?? os.homedir()
  if (
    existsSync(unitPath(home, "openteam-agent@.service")) &&
    existsSync(unitPath(home, "openteam.target"))
  ) {
    return
  }
  throw new Error("openteam service units are not installed; run `openteam service install` or `openteam service start` first")
}

const argValue = (args: string[], key: string, fallback = "") => {
  const index = args.indexOf(key)
  if (index === -1) return fallback
  return args[index + 1] ?? fallback
}

const hasFlag = (args: string[], key: string) => args.includes(key)

const serviceAgentArg = (args: string[]) => {
  const candidate = args[2] ?? ""
  return candidate && !candidate.startsWith("-") ? candidate : "orchestrator-01"
}

const printHelp = () => {
  console.log(`openteam service commands:

  service install
  service start [agentId]
  service stop [agentId]
  service restart [agentId] [--tail]
  service status [agentId]
  service logs [agentId] [--tail] [--lines <n>]
  service enable
  service disable
`)
}

export const serviceCommand = async (
  app: AppCfg,
  sub: string | undefined,
  args: string[],
  options: ServiceCommandOptions = {},
) => {
  const runner = options.runner ?? defaultRunner
  const command = sub || "status"
  const agentId = serviceAgentArg(args)
  const unit = serviceName(agentId)

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp()
    return
  }

  if (command === "install") {
    const installed = await installServiceUnits(app, options)
    console.log(`installed ${installed.agentUnit}`)
    console.log(`installed ${installed.targetUnit}`)
    return
  }

  if (command === "start" || command === "restart") {
    await installServiceUnits(app, options)
    assertOk(systemctl(runner, [command, unit], {encoding: "buffer"}), `systemctl ${command} ${unit}`)
    console.log(`${command}ed ${unit}`)
    if (hasFlag(args, "--tail")) {
      journalctl(runner, ["-u", unit, "-f"], {stdio: "inherit"})
    }
    return
  }

  if (command === "stop") {
    requireInstalled(options)
    assertOk(systemctl(runner, ["stop", unit], {encoding: "buffer"}), `systemctl stop ${unit}`)
    console.log(`stopped ${unit}`)
    return
  }

  if (command === "status") {
    requireInstalled(options)
    const result = systemctl(runner, ["status", unit, "--no-pager"], {stdio: "inherit"})
    if (typeof result.status === "number") process.exitCode = result.status
    return
  }

  if (command === "logs") {
    requireInstalled(options)
    const lines = argValue(args, "--lines", "80")
    const logArgs = ["-u", unit, "-n", lines, "--no-pager"]
    if (hasFlag(args, "--tail") || hasFlag(args, "-f")) logArgs.push("-f")
    const result = journalctl(runner, logArgs, {stdio: "inherit"})
    if (typeof result.status === "number") process.exitCode = result.status
    return
  }

  if (command === "enable" || command === "disable") {
    await installServiceUnits(app, options)
    assertOk(systemctl(runner, [command, "openteam.target"], {encoding: "buffer"}), `systemctl ${command} openteam.target`)
    console.log(`${command}d openteam.target`)
    return
  }

  printHelp()
  process.exitCode = 1
}
