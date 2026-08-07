import { describe, expect, test } from "bun:test"
import type { Part, ToolPart } from "@opencode-ai/sdk/v2/client"
import { minorToolError } from "./minor-error"

function tool(input: { tool: string; status: ToolPart["state"]["status"] }): Part {
  const base = {
    id: "prt_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "tool" as const,
    callID: "call_1",
    tool: input.tool,
  }
  if (input.status === "error") {
    return {
      ...base,
      state: { status: "error", input: {}, error: "ENOENT", time: { start: 0, end: 1 } },
    } as Part
  }
  return { ...base, state: { status: input.status, input: {} } } as Part
}

describe("minorToolError", () => {
  test("matches failed file tools", () => {
    for (const name of ["read", "write", "edit", "multiedit", "apply_patch", "glob", "grep", "list"]) {
      expect(minorToolError(tool({ tool: name, status: "error" }))).toBe(true)
    }
  })

  test("ignores file tools that did not fail", () => {
    expect(minorToolError(tool({ tool: "read", status: "completed" }))).toBe(false)
    expect(minorToolError(tool({ tool: "write", status: "running" }))).toBe(false)
  })

  test("keeps failures the user should see", () => {
    expect(minorToolError(tool({ tool: "bash", status: "error" }))).toBe(false)
    expect(minorToolError(tool({ tool: "task", status: "error" }))).toBe(false)
    expect(minorToolError(tool({ tool: "webfetch", status: "error" }))).toBe(false)
  })

  test("ignores non tool parts", () => {
    const text = {
      id: "prt_2",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "text",
      text: "hello",
    } as Part
    expect(minorToolError(text)).toBe(false)
  })
})
