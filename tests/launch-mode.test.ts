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

  test("rejects explicit attach in non-interactive worker launch", () => {
    expect(() => resolveLaunchExecutionMode({
      args: ["--attach"],
      role: "builder",
      mode: "web",
      stdinIsTTY: false,
      stdoutIsTTY: false,
      env: {},
    })).toThrow("--attach is not allowed")
  })

  test("allows internal detached supervisor child to attach to its log", () => {
    expect(resolveLaunchExecutionMode({
      args: ["--attach"],
      role: "builder",
      mode: "web",
      stdinIsTTY: false,
      stdoutIsTTY: false,
      env: {OPENTEAM_INTERNAL_DETACHED_LAUNCH: "1", OPENTEAM_OPENCODE_CONTEXT: "1"},
    })).toEqual({
      detached: false,
      explicit: true,
      reason: "--attach requested",
    })
  })

  test("rejects explicit attach in managed OpenCode context even with interactive stdio", () => {
    expect(() => resolveLaunchExecutionMode({
      args: ["--attach"],
      role: "builder",
      mode: "web",
      stdinIsTTY: true,
      stdoutIsTTY: true,
      env: {OPENTEAM_OPENCODE_CONTEXT: "1"},
    })).toThrow("--attach is not allowed")
  })

  test("detects managed openteam OpenCode context even when stdio looks interactive", () => {
    const mode = resolveLaunchExecutionMode({
      args: [],
      role: "builder",
      mode: "web",
      stdinIsTTY: true,
      stdoutIsTTY: true,
      env: {OPENTEAM_OPENCODE_STATE_DIR: "/tmp/openteam-state"},
    })

    expect(mode.detached).toBe(true)
    expect(mode.explicit).toBe(false)
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
