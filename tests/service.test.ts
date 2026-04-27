import {mkdtemp, readFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {describe, expect, test} from "bun:test"
import {installServiceUnits, renderAgentServiceUnit, renderTargetUnit, serviceCommand, type ServiceCommandRunner} from "../src/commands/service.js"
import type {AppCfg} from "../src/types.js"

const app = (root: string) => ({root} as AppCfg)

const ok = () => ({
  pid: 1,
  output: [],
  stdout: Buffer.from(""),
  stderr: Buffer.from(""),
  status: 0,
  signal: null,
})

describe("service command", () => {
  test("renders systemd units for the active checkout", () => {
    expect(renderAgentServiceUnit("/opt/openteam")).toContain("WorkingDirectory=/opt/openteam")
    expect(renderAgentServiceUnit("/opt/openteam")).toContain("ExecStart=/opt/openteam/scripts/launch-agent %i")
    expect(renderTargetUnit()).toContain("WantedBy=default.target")
  })

  test("installs generated user units and reloads systemd", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "openteam-service-"))
    const calls: string[] = []
    const runner: ServiceCommandRunner = (command, args) => {
      calls.push([command, ...args].join(" "))
      return ok()
    }

    const installed = await installServiceUnits(app("/tmp/openteam"), {home, runner})

    expect(await readFile(installed.agentUnit, "utf8")).toContain("WorkingDirectory=/tmp/openteam")
    expect(await readFile(installed.targetUnit, "utf8")).toContain("WantedBy=default.target")
    expect(calls).toEqual(["systemctl --user daemon-reload"])
  })

  test("restart refreshes units before restarting the orchestrator service", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "openteam-service-"))
    const calls: string[] = []
    const runner: ServiceCommandRunner = (command, args) => {
      calls.push([command, ...args].join(" "))
      return ok()
    }
    const originalLog = console.log
    console.log = () => {}

    try {
      await serviceCommand(app("/tmp/openteam"), "restart", ["service", "restart", "orchestrator-01"], {home, runner})
    } finally {
      console.log = originalLog
    }

    expect(calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user restart openteam-agent@orchestrator-01.service",
    ])
  })
})
