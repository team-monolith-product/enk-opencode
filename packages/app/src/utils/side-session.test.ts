import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { findAttachment, isImagePath, isSideSession, pendingHandoffs } from "./side-session"

const sideRules = [
  { permission: "*", pattern: "*", action: "deny" as const },
  { permission: "handoff", pattern: "*", action: "allow" as const },
]

describe("isSideSession", () => {
  test("is a child session that allows handoff", () => {
    expect(isSideSession({ parentID: "ses_main", permission: sideRules })).toBe(true)
  })

  test("subagent children and root sessions are not side chats", () => {
    expect(
      isSideSession({ parentID: "ses_main", permission: [{ permission: "todowrite", pattern: "*", action: "deny" }] }),
    ).toBe(false)
    expect(isSideSession({ parentID: undefined, permission: sideRules })).toBe(false)
    expect(isSideSession(undefined)).toBe(false)
  })
})

const message = (id: string) => ({ id, role: "assistant" }) as Message

const tool = (callID: string, status: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ type: "tool", tool: "handoff", callID, state: { status, input, ...extra } }) as unknown as Part

describe("pendingHandoffs", () => {
  test("returns completed, unhandled handoff calls in order with normalized input", () => {
    const parts: Record<string, Part[]> = {
      m1: [
        tool("c1", "completed", {
          text: "first",
          files: [{ path: "a.ts", start: 3 }, { nope: 1 }],
          attachments: ["x.png", 4],
        }),
      ],
      m2: [tool("c2", "running", { text: "pending" }), tool("c3", "completed", { text: "second" })],
    }
    const result = pendingHandoffs([message("m1"), message("m2")], parts, new Set())
    expect(result).toEqual([
      {
        callID: "c1",
        input: {
          text: "first",
          files: [{ path: "a.ts", start: 3, end: undefined, comment: undefined }],
          attachments: ["x.png"],
        },
      },
      { callID: "c3", input: { text: "second", files: [], attachments: [] } },
    ])
  })

  test("skips handled calls, errored calls and calls without text", () => {
    const parts: Record<string, Part[]> = {
      m1: [
        tool("done", "completed", { text: "x" }),
        tool("err", "error", { text: "x" }),
        tool("blank", "completed", { text: "  " }),
      ],
    }
    expect(pendingHandoffs([message("m1")], parts, new Set(["done"]))).toEqual([])
  })
})

describe("findAttachment", () => {
  test("finds user file parts and tool attachments by name, latest first", () => {
    const parts: Record<string, Part[]> = {
      m1: [{ type: "file", filename: "shot.png", mime: "image/png", url: "data:old" } as Part],
      m2: [
        { type: "file", filename: "shot.png", mime: "image/png", url: "data:new" } as Part,
        {
          type: "tool",
          tool: "read",
          state: { status: "completed", attachments: [{ filename: "logo.png", mime: "image/png", url: "data:logo" }] },
        } as unknown as Part,
      ],
    }
    const list = [message("m1"), message("m2")]
    expect(findAttachment(list, parts, "shot.png")?.url).toBe("data:new")
    expect(findAttachment(list, parts, "logo.png")?.url).toBe("data:logo")
    expect(findAttachment(list, parts, "ghost.png")).toBeUndefined()
  })

  test("also matches the URL-encoded form of a name", () => {
    const parts: Record<string, Part[]> = {
      m1: [{ type: "file", filename: "build log.txt", mime: "text/plain", url: "data:log" } as Part],
    }
    expect(findAttachment([message("m1")], parts, "build%20log.txt")?.url).toBe("data:log")
    expect(findAttachment([message("m1")], parts, "%E0%A4%A")).toBeUndefined()
  })
})

test("isImagePath uploads raster images and references everything else", () => {
  expect(isImagePath("public/logo.PNG")).toBe(true)
  expect(isImagePath("a/b.jpeg")).toBe(true)
  expect(isImagePath("icon.svg")).toBe(false)
  expect(isImagePath("src/app.ts")).toBe(false)
})
