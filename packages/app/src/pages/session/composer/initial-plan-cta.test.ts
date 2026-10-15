import { describe, expect, test } from "bun:test"
import {
  initialPlanActive,
  initialPlanMode,
  initialPlanRefreshKey,
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

describe("initialPlanRefreshKey", () => {
  const signals = { status: "busy", count: 4, lastID: "msg_4", lastCompleted: undefined, lastUserID: "msg_3" }

  test("follows every change while the plan is in play", () => {
    expect(initialPlanRefreshKey(state(), signals)).not.toBe(initialPlanRefreshKey(state(), { ...signals, count: 5 }))
    expect(initialPlanRefreshKey(undefined, signals)).not.toBe(
      initialPlanRefreshKey(undefined, { ...signals, status: "idle" }),
    )
  })

  test("stops asking once build started", () => {
    const started = state({ buildStarted: true })
    expect(initialPlanRefreshKey(started, signals)).toBe(initialPlanRefreshKey(started, { ...signals, count: 9 }))
  })

  test("asks a session without a handoff again only for a new user message", () => {
    const none = state({ handoffMessageID: null })
    expect(initialPlanRefreshKey(none, signals)).toBe(
      initialPlanRefreshKey(none, { ...signals, count: 9, status: "idle" }),
    )
    expect(initialPlanRefreshKey(none, signals)).not.toBe(
      initialPlanRefreshKey(none, { ...signals, lastUserID: "msg_9" }),
    )
  })
})
