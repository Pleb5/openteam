import {describe, expect, test} from "bun:test"
import {
  D_TAG_GRASP_SERVERS,
  D_TAG_PROFILE_TOKENS,
  KIND_APP_DATA,
  KIND_DM,
  KIND_DM_RELAYS,
  KIND_GIT_COMMENT,
  KIND_GIT_ISSUE,
  KIND_GIT_PULL_REQUEST,
  KIND_GIT_PULL_REQUEST_UPDATE,
  KIND_GIT_STATUS_APPLIED,
  KIND_GRASP_SERVERS,
  KIND_OUTBOX_RELAYS,
  KIND_REPO_ANNOUNCEMENT,
  REPO_EVENT_KINDS,
  TAG_NAMESPACE_GIT_ROLE,
} from "../src/events.js"

describe("event constants", () => {
  test("keeps protocol kind numbers centralized and explicit", () => {
    expect(KIND_REPO_ANNOUNCEMENT).toBe(30617)
    expect(KIND_DM).toBe(4444)
    expect(KIND_OUTBOX_RELAYS).toBe(10002)
    expect(KIND_DM_RELAYS).toBe(10050)
    expect(KIND_APP_DATA).toBe(30078)
    expect(KIND_GRASP_SERVERS).toBe(30002)
    expect(KIND_GIT_ISSUE).toBe(1621)
    expect(KIND_GIT_COMMENT).toBe(1111)
    expect(KIND_GIT_PULL_REQUEST).toBe(1618)
    expect(KIND_GIT_PULL_REQUEST_UPDATE).toBe(1619)
    expect(KIND_GIT_STATUS_APPLIED).toBe(1631)
  })

  test("exports repo event kind and namespace groups", () => {
    expect(REPO_EVENT_KINDS).toContain(KIND_GIT_ISSUE)
    expect(REPO_EVENT_KINDS).toContain(KIND_GIT_PULL_REQUEST)
    expect(D_TAG_PROFILE_TOKENS).toBe("app/nostr-git/tokens")
    expect(D_TAG_GRASP_SERVERS).toBe("grasp-servers")
    expect(TAG_NAMESPACE_GIT_ROLE).toBe("org.nostr.git.role")
  })
})
