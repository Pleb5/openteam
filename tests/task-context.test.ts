import {describe, expect, test} from "bun:test"
import {
  encodeTaskContextEnv,
  recipientsFromEnv,
  sourceFromEnv,
  TASK_RECIPIENTS_ENV,
  TASK_SOURCE_EVENT_ID_ENV,
  TASK_SOURCE_FROM_ENV,
  TASK_SOURCE_KIND_ENV,
} from "../src/task-context.js"

describe("task context env", () => {
  test("round-trips notification recipients and source metadata", () => {
    const env = encodeTaskContextEnv({
      recipients: ["npub1operator", "npub1operator", "npub1watcher"],
      source: {
        kind: "dm",
        eventId: "event-a",
        from: "npub1operator",
      },
    })

    expect(recipientsFromEnv(env)).toEqual(["npub1operator", "npub1watcher"])
    expect(sourceFromEnv(env)).toEqual({
      kind: "dm",
      eventId: "event-a",
      from: "npub1operator",
    })
  })

  test("accepts legacy comma separated recipients", () => {
    expect(recipientsFromEnv({
      [TASK_RECIPIENTS_ENV]: "npub1a, npub1b",
    })).toEqual(["npub1a", "npub1b"])
  })

  test("rejects invalid source kind", () => {
    expect(() => sourceFromEnv({
      [TASK_SOURCE_KIND_ENV]: "invalid",
      [TASK_SOURCE_EVENT_ID_ENV]: "event-a",
      [TASK_SOURCE_FROM_ENV]: "npub1operator",
    })).toThrow("invalid task source kind invalid")
  })
})
