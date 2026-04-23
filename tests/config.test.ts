import {describe, expect, test} from "bun:test"
import {agentPaths} from "../src/config.js"
import type {AppCfg} from "../src/types.js"

describe("config helpers", () => {
  test("builds stable runtime paths for an agent", () => {
    const app: AppCfg = {
      root: "/home/johnd/Work/openteam",
      config: {
        runtimeRoot: "/home/johnd/Work/openteam/runtime",
        opencode: {binary: "opencode", model: "", agent: "build"},
        browser: {
          headless: false,
          executablePath: "/usr/bin/chromium",
          mcp: {name: "playwright", command: [], environment: {}},
        },
        providers: {},
        repos: {},
        reporting: {allowFrom: [], reportTo: [], pollIntervalMs: 5000},
        agents: {},
      },
    }

    const paths = agentPaths(app, "builder-01")

    expect(paths.root).toBe("/home/johnd/Work/openteam/runtime/agents/builder-01")
    expect(paths.workspace).toBe("/home/johnd/Work/openteam/runtime/agents/builder-01/workspace")
    expect(paths.browser).toBe("/home/johnd/Work/openteam/runtime/agents/builder-01/browser")
    expect(paths.worktrees).toBe("/home/johnd/Work/openteam/runtime/agents/builder-01/worktrees")
    expect(paths.stateFile).toBe("/home/johnd/Work/openteam/runtime/agents/builder-01/state.json")
  })
})
