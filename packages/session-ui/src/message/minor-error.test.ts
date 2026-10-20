import { describe, expect, test } from "bun:test"
import type { SessionMessageAssistant, SessionMessageAssistantTool } from "@opencode/client/promise"
import { minorToolError } from "./minor-error"

const time = { created: 1 }

function tool(name: string, status: "error" | "completed" | "running"): SessionMessageAssistantTool {
  if (status === "error")
    return {
      type: "tool",
      id: "tool_1",
      name,
      state: { status, input: {}, error: { type: "unknown", message: "ENOENT" } },
      time,
    } as SessionMessageAssistantTool
  if (status === "running")
    return { type: "tool", id: "tool_1", name, state: { status, input: {}, metadata: {} }, time }
  return {
    type: "tool",
    id: "tool_1",
    name,
    state: { status, input: {}, content: [{ type: "text", text: "ok" }] },
    time,
  } as SessionMessageAssistantTool
}

describe("minorToolError", () => {
  test("matches failed file tools", () => {
    for (const name of ["read", "write", "edit", "multiedit", "patch", "apply_patch", "glob", "grep", "list"])
      expect(minorToolError(tool(name, "error"))).toBe(true)
  })

  test("ignores file tools that did not fail", () => {
    expect(minorToolError(tool("read", "completed"))).toBe(false)
    expect(minorToolError(tool("write", "running"))).toBe(false)
  })

  test("keeps failures the user should see", () => {
    expect(minorToolError(tool("shell", "error"))).toBe(false)
    expect(minorToolError(tool("subagent", "error"))).toBe(false)
    expect(minorToolError(tool("webfetch", "error"))).toBe(false)
  })

  test("ignores non tool content", () => {
    const text: SessionMessageAssistant["content"][number] = { type: "text", text: "hello" }
    expect(minorToolError(text)).toBe(false)
  })
})
