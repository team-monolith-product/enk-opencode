import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { INITIAL_PLAN_MARKER, showInitialPlanCta } from "./initial-plan-cta"

const user = (id: string, agent: string) =>
  ({
    id,
    sessionID: "ses",
    role: "user",
    time: { created: 1 },
    agent,
    model: { providerID: "p", modelID: "m" },
  }) as UserMessage

const reply = (id: string, agent: string, extra?: Partial<AssistantMessage>) =>
  ({
    id,
    sessionID: "ses",
    role: "assistant",
    time: { created: 2, completed: 3 },
    agent,
    mode: agent,
    parentID: "x",
    modelID: "m",
    providerID: "p",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...extra,
  }) as AssistantMessage

const text = (messageID: string, metadata?: Record<string, unknown>) =>
  ({ id: `${messageID}-p`, sessionID: "ses", messageID, type: "text", text: "...", metadata }) as Part

function check(messages: Message[], busy = false) {
  const parts: Record<string, Part[]> = { handoff: [text("handoff", { [INITIAL_PLAN_MARKER]: true })] }
  for (const msg of messages) parts[msg.id] ??= [text(msg.id)]
  return showInitialPlanCta({ messages, parts: (id) => parts[id], busy })
}

describe("showInitialPlanCta", () => {
  test("shows once plan has answered the initial plan", () => {
    expect(check([user("handoff", "plan"), reply("a1", "plan")])).toBe(true)
  })

  test("stays while the team keeps talking to plan", () => {
    expect(check([user("handoff", "plan"), reply("a1", "plan"), user("u2", "plan"), reply("a2", "plan")])).toBe(true)
  })

  test("hides while plan is still answering", () => {
    expect(check([user("handoff", "plan"), reply("a1", "plan")], true)).toBe(false)
    expect(check([user("handoff", "plan"), reply("a1", "plan", { time: { created: 2 } })])).toBe(false)
  })

  test("hides when plan failed", () => {
    const error = { name: "UnknownError", data: { message: "boom" } } as AssistantMessage["error"]
    expect(check([user("handoff", "plan"), reply("a1", "plan", { error })])).toBe(false)
  })

  test("hides once build was requested", () => {
    expect(check([user("handoff", "plan"), reply("a1", "plan"), user("u2", "build"), reply("a2", "build")])).toBe(false)
    expect(check([user("handoff", "plan"), reply("a1", "plan"), user("u2", "build")])).toBe(false)
  })

  test("never shows without the initial plan handoff", () => {
    expect(check([user("u1", "plan"), reply("a1", "plan")])).toBe(false)
    expect(check([])).toBe(false)
  })
})
