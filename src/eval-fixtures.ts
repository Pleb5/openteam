import {roleOutputContractLabels} from "./role-contracts.js"

export type RoleFinalResponseScore = {
  role: string
  ok: boolean
  presentLabels: string[]
  missingLabels: string[]
}

export type RoleFinalResponseFixture = {
  name: string
  role: string
  text: string
  ok: boolean
  missingLabels?: string[]
}

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const labelPattern = (label: string) =>
  new RegExp(`(^|\\n)\\s*(?:[-*]\\s*)?(?:\\*\\*)?${escapeRegExp(label)}\\s*:(?:\\*\\*)?`, "i")

export const scoreRoleFinalResponse = (role: string, text: string): RoleFinalResponseScore => {
  const labels = roleOutputContractLabels(role)
  const presentLabels = labels.filter(label => labelPattern(label).test(text))
  const missingLabels = labels.filter(label => !presentLabels.includes(label))

  return {
    role,
    ok: labels.length > 0 && missingLabels.length === 0,
    presentLabels,
    missingLabels,
  }
}

export const scoreRoleFinalResponseFixture = (fixture: RoleFinalResponseFixture) => {
  const score = scoreRoleFinalResponse(fixture.role, fixture.text)
  const expectedMissing = fixture.missingLabels ?? []

  return {
    ...score,
    expectedOk: fixture.ok,
    expectedMissing,
    matchesExpectation: score.ok === fixture.ok &&
      expectedMissing.every(label => score.missingLabels.includes(label)),
  }
}
