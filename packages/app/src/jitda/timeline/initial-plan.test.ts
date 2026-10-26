import { describe, expect, test } from "bun:test"
import { isInitialPlan } from "./initial-plan"

describe("isInitialPlan", () => {
  test("recognizes only the server's initial plan handoff", () => {
    expect(isInitialPlan({ metadata: { enkInitialPlan: true, planningID: "7" } })).toBe(true)
    expect(isInitialPlan({ metadata: { enkInitialPlan: "true" } })).toBe(false)
    expect(isInitialPlan({ metadata: { jitda: { docID: "doc_1" } } })).toBe(false)
    expect(isInitialPlan({})).toBe(false)
  })
})
