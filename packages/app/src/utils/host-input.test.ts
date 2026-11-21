import { describe, expect, test } from "bun:test"
import { applyHostInputMessage, hostInputActive } from "./host-input"

describe("host input lock", () => {
  test("follows the parent's active flag", () => {
    expect(applyHostInputMessage({ type: "jitda.host-input", active: true })).toBe(true)
    expect(hostInputActive()).toBe(true)
    expect(applyHostInputMessage({ type: "jitda.host-input", active: false })).toBe(true)
    expect(hostInputActive()).toBe(false)
  })

  test("ignores other messages", () => {
    expect(applyHostInputMessage({ type: "project.summary.request" })).toBe(false)
    expect(applyHostInputMessage(null)).toBe(false)
    expect(hostInputActive()).toBe(false)
  })
})
