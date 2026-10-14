import { describe, expect, test } from "bun:test"
import {
  INITIAL_PLAN_MARKER,
  initialPlanActive,
  initialPlanMode,
  isInitialPlanHandoff,
  type InitialPlanSessionState,
} from "./initial-plan-cta"

const state = (input: Partial<InitialPlanSessionState> = {}): InitialPlanSessionState => ({
  handoffMessageID: "msg_handoff",
  planningID: "7",
  buildStarted: false,
  lastPlanStatus: "done",
  ...input,
})

describe("initialPlanMode", () => {
  test("offers the build CTA once plan has answered", () => {
    expect(initialPlanMode(state(), false)).toBe("ready")
  })

  test("shows the planning status while plan is still answering", () => {
    expect(initialPlanMode(state({ lastPlanStatus: "running" }), false)).toBe("running")
    expect(initialPlanMode(state(), true)).toBe("running")
  })

  test("offers a retry when the plan run failed", () => {
    expect(initialPlanMode(state({ lastPlanStatus: "error" }), false)).toBe("failed")
  })

  test("disappears once build started or without a handoff", () => {
    expect(initialPlanMode(state({ buildStarted: true }), false)).toBeUndefined()
    expect(initialPlanMode(state({ handoffMessageID: null }), false)).toBeUndefined()
    expect(initialPlanMode(undefined, false)).toBeUndefined()
  })
})

describe("initialPlanActive", () => {
  test("keeps plan as the default agent until build starts", () => {
    expect(initialPlanActive(state())).toBe(true)
    expect(initialPlanActive(state({ lastPlanStatus: "error" }))).toBe(true)
    expect(initialPlanActive(state({ buildStarted: true }))).toBe(false)
  })
})

describe("isInitialPlanHandoff", () => {
  test("recognizes only the marked handoff text", () => {
    expect(isInitialPlanHandoff({ type: "text", metadata: { [INITIAL_PLAN_MARKER]: true, planningID: "7" } })).toBe(
      true,
    )
    expect(isInitialPlanHandoff({ type: "text", metadata: {} })).toBe(false)
    expect(isInitialPlanHandoff({ type: "file", metadata: { [INITIAL_PLAN_MARKER]: true } })).toBe(false)
  })
})
