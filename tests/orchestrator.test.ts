import {describe, expect, test} from "bun:test"
import {parseOperatorRequest} from "../src/orchestrator.js"

describe("orchestrator operator request parsing", () => {
  test("parses researcher work requests", () => {
    expect(parseOperatorRequest(
      "work on nostr://npub1example/repo as researcher in code mode with model openai/gpt-5.4 in parallel and do compare implementation options",
    )).toEqual({
      kind: "work",
      target: "nostr://npub1example/repo",
      role: "researcher",
      mode: "code",
      model: "openai/gpt-5.4",
      parallel: true,
      task: "compare implementation options",
    })
  })

  test("parses research shortcut as researcher code task", () => {
    expect(parseOperatorRequest(
      "research nostr://npub1example/repo and identify the safest fix direction",
    )).toEqual({
      kind: "research",
      target: "nostr://npub1example/repo",
      role: "researcher",
      mode: "code",
      model: undefined,
      parallel: false,
      task: "identify the safest fix direction",
    })
  })

  test("parses plan shortcut as researcher plan task", () => {
    expect(parseOperatorRequest(
      "plan 30617:abc:repo in web mode and produce a builder handoff",
    )).toEqual({
      kind: "research",
      target: "30617:abc:repo",
      role: "researcher",
      mode: "web",
      model: undefined,
      parallel: false,
      task: "Produce a research-backed implementation plan: produce a builder handoff",
    })
  })
})
