import { describe, expect, test } from "bun:test"
import { base64Encode } from "@opencode-ai/util/encode"
import { currentSession, lastTurn, PROMPT_MAX } from "./last-turn-bridge"

const user = (text: string, extra: object = {}) => ({
  info: { role: "user", time: { created: 100 } },
  parts: [{ type: "text", text, ...extra }],
})
const assistant = (...parts: object[]) => ({ info: { role: "assistant" }, parts })

describe("lastTurn", () => {
  test("joins every assistant step after the last prompt", () => {
    const turn = lastTurn([
      user("first"),
      assistant({ type: "text", text: "old answer" }),
      user("저장 버튼이 안 돼요"),
      assistant({ type: "tool", tool: "edit" }, { type: "text", text: "고쳐 볼게요" }),
      assistant({ type: "text", text: "고쳤어요" }),
    ])

    expect(turn).toEqual({ prompt: "저장 버튼이 안 돼요", response: "고쳐 볼게요\n\n고쳤어요", at: 100 })
  })

  test("skips synthetic prompts and keeps an unanswered prompt", () => {
    const turn = lastTurn([user("real"), user("auto", { synthetic: true })])

    expect(turn).toEqual({ prompt: "real", response: "", at: 100 })
  })

  test("returns nothing without a prompt", () => {
    expect(lastTurn([assistant({ type: "text", text: "hi" })])).toBeUndefined()
  })

  test("clips a long prompt", () => {
    expect(lastTurn([user("a".repeat(PROMPT_MAX + 10))])?.prompt.length).toBe(PROMPT_MAX + 1)
  })
})

describe("currentSession", () => {
  test("reads the session and directory from the hub path", () => {
    const dir = base64Encode("/home/jovyan/teams/3/project-directory")
    expect(currentSession(`/user/abc/${dir}/session/ses_1`)).toEqual({
      directory: "/home/jovyan/teams/3/project-directory",
      sessionID: "ses_1",
    })
    expect(currentSession("/user/abc/")).toBeUndefined()
  })
})
