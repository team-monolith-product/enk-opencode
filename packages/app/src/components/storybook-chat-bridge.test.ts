import { describe, expect, test } from "bun:test"
import { assistantErrorDetail, storybookToolEvent, STORYBOOK_TOOLS } from "./storybook-chat-bridge"

function toolEvent(tool: string, status = "completed", sessionID = "ses_1") {
  return {
    type: "message.part.updated",
    properties: { part: { type: "tool", tool, sessionID, state: { status } } },
  }
}

describe("storybookToolEvent", () => {
  test("matches completed storybook tool parts", () => {
    for (const tool of STORYBOOK_TOOLS) {
      expect(storybookToolEvent(toolEvent(tool))).toBe(tool)
    }
  })

  test("ignores other tools, other event types, and unfinished states", () => {
    expect(storybookToolEvent(toolEvent("bash"))).toBeUndefined()
    expect(storybookToolEvent(toolEvent("upsert_page", "running"))).toBeUndefined()
    expect(storybookToolEvent({ type: "session.idle", properties: {} })).toBeUndefined()
    expect(storybookToolEvent(undefined)).toBeUndefined()
    expect(storybookToolEvent("nope")).toBeUndefined()
  })

  test("filters by session id when one is given", () => {
    expect(storybookToolEvent(toolEvent("upsert_page"), "ses_1")).toBe("upsert_page")
    expect(storybookToolEvent(toolEvent("upsert_page"), "ses_2")).toBeUndefined()
    expect(storybookToolEvent(toolEvent("upsert_page"))).toBe("upsert_page")
  })
})

describe("assistantErrorDetail", () => {
  test("prefers the error data message", () => {
    expect(assistantErrorDetail({ error: { name: "UnknownError", data: { message: "boom" } } })).toBe("boom")
  })

  test("falls back to the error name", () => {
    expect(assistantErrorDetail({ error: { name: "MessageAbortedError" } })).toBe("MessageAbortedError")
  })

  test("returns undefined for clean turns", () => {
    expect(assistantErrorDetail({})).toBeUndefined()
    expect(assistantErrorDetail(undefined)).toBeUndefined()
  })
})
