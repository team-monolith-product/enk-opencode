import { describe, expect, test } from "bun:test"
import { AiUsage } from "./ai-usage"
import type { MessageV2 } from "@/session/message-v2"

// A minimal completed assistant message, only the fields buildAttributes reads.
function assistant(overrides: Partial<MessageV2.Assistant> = {}): MessageV2.Assistant {
  return {
    id: "msg_1",
    role: "assistant",
    sessionID: "ses_1",
    modelID: "claude-sonnet-4-x",
    providerID: "anthropic",
    cost: 0.0123,
    path: { cwd: "/fsx/teams/45/project-directory", root: "/fsx/teams/45/project-directory" },
    tokens: { input: 100, output: 200, reasoning: 10, cache: { read: 30, write: 5 } },
    time: { created: 1_000, completed: 1_717_864_414_977 },
    ...overrides,
  } as MessageV2.Assistant
}

describe("AiUsage.buildAttributes", () => {
  test("sends mount_path verbatim from path.cwd", () => {
    expect(AiUsage.buildAttributes(assistant()).mount_path).toBe("/fsx/teams/45/project-directory")
  })

  test("sums all token categories into one integer", () => {
    // 100 + 200 + 10 + 30 + 5 = 345
    expect(AiUsage.buildAttributes(assistant()).tokens).toBe(345)
  })

  test("tolerates missing token sub-fields", () => {
    expect(AiUsage.buildAttributes(assistant({ tokens: { input: 7, output: 3 } as any })).tokens).toBe(10)
  })

  test("formats used_at as ISO8601 from completed timestamp", () => {
    expect(AiUsage.buildAttributes(assistant()).used_at).toBe(new Date(1_717_864_414_977).toISOString())
  })

  test("passes through model_id and cost", () => {
    const attrs = AiUsage.buildAttributes(assistant())
    expect(attrs.model_id).toBe("claude-sonnet-4-x")
    expect(attrs.cost).toBe(0.0123)
  })
})
