import {describe, expect, test} from "bun:test"
import {resolveLaunchExecutionMode} from "../src/launch-mode.js"

describe("launch execution mode", () => {
  test("keeps interactive worker launch attached by default", () => {
    expect(resolveLaunchExecutionMode({
      args: [],
      role: "builder",
      mode: "web",
      stdinIsTTY: true,
      stdoutIsTTY: true,
      env: {},
    })).toEqual({
      detached: false,
      explicit: false,
      reason: "interactive launch defaults to attached",
    })
  })

  test("defaults non-interactive worker launch to detached", () => {
    const mode = resolveLaunchExecutionMode({
      args: [],
      role: "builder",
      mode: "web",
      stdinIsTTY: false,
      stdoutIsTTY: false,
      env: {},
    })

    expect(mode.detached).toBe(true)
    expect(mode.explicit).toBe(false)
    expect(mode.reason).toContain("non-interactive worker launch")
  })

  test("detects OpenCode sessions even when stdio looks interactive", () => {
    const mode = resolveLaunchExecutionMode({
      args: [],
      role: "qa",
      mode: "web",
      stdinIsTTY: true,
      stdoutIsTTY: true,
      env: {OPENCODE_SESSION: "ses_test"},
    })

    expect(mode.detached).toBe(true)
    expect(mode.explicit).toBe(false)
  })

  test("honors explicit attach in non-interactive worker launch", () => {
    expect(resolveLaunchExecutionMode({
      args: ["--attach"],
      role: "builder",
      mode: "web",
      stdinIsTTY: false,
      stdoutIsTTY: false,
      env: {},
    })).toEqual({
      detached: false,
      explicit: true,
      reason: "--attach requested",
    })
  })

  test("honors explicit detach in interactive launch", () => {
    expect(resolveLaunchExecutionMode({
      args: ["--detach"],
      role: "builder",
      mode: "web",
      stdinIsTTY: true,
      stdoutIsTTY: true,
      env: {},
    })).toEqual({
      detached: true,
      explicit: true,
      reason: "--detach requested",
    })
  })

  test("rejects conflicting attach flags", () => {
    expect(() => resolveLaunchExecutionMode({
      args: ["--detach", "--attach"],
      role: "builder",
      stdinIsTTY: true,
      stdoutIsTTY: true,
      env: {},
    })).toThrow("choose only one of --detach or --attach")
  })

  test("does not implicitly detach orchestrator launch", () => {
    expect(resolveLaunchExecutionMode({
      args: [],
      role: "orchestrator",
      mode: "code",
      stdinIsTTY: false,
      stdoutIsTTY: false,
      env: {},
    }).detached).toBe(false)
  })
})
