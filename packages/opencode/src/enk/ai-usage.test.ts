import { describe, expect, test } from "bun:test"
import { AiUsage } from "./ai-usage"
import type { MessageV2 } from "@/session/message-v2"

// A minimal completed assistant message, only the fields the builders read.
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

describe("AiUsage.buildStartAttributes", () => {
  test("tags the turn-start marker as phase:start with step_index -1", () => {
    const attrs = AiUsage.buildStartAttributes(assistant())
    expect(attrs.phase).toBe("start")
    expect(attrs.message_id).toBe("msg_1")
    expect(attrs.step_index).toBe(-1)
  })

  test("carries zero counts and zero cost — a pure marker", () => {
    const attrs = AiUsage.buildStartAttributes(assistant())
    expect(attrs.tokens).toBe(0)
    expect(attrs.input).toBe(0)
    expect(attrs.output).toBe(0)
    expect(attrs.cost).toBe(0)
  })

  test("uses the message created timestamp for used_at", () => {
    expect(AiUsage.buildStartAttributes(assistant()).used_at).toBe(new Date(1_000).toISOString())
  })
})

describe("AiUsage.buildAttributes", () => {
  test("sends mount_path verbatim from path.cwd", () => {
    expect(AiUsage.buildAttributes(assistant()).mount_path).toBe("/fsx/teams/45/project-directory")
  })

  test("passes through model_id", () => {
    expect(AiUsage.buildAttributes(assistant()).model_id).toBe("claude-sonnet-4-x")
  })

  test("tags the turn-end marker as phase:final with message_id and step_index -1", () => {
    const attrs = AiUsage.buildAttributes(assistant())
    expect(attrs.phase).toBe("final")
    expect(attrs.message_id).toBe("msg_1")
    expect(attrs.step_index).toBe(-1)
  })

  test("carries zero counts and zero cost — the fee rides only on step records", () => {
    const attrs = AiUsage.buildAttributes(assistant())
    expect(attrs.tokens).toBe(0)
    expect(attrs.input).toBe(0)
    expect(attrs.output).toBe(0)
    expect(attrs.reasoning).toBe(0)
    expect(attrs.cache_read).toBe(0)
    expect(attrs.cache_write).toBe(0)
    expect(attrs.cost).toBe(0)
  })

  test("formats used_at as ISO8601 from completed timestamp", () => {
    expect(AiUsage.buildAttributes(assistant()).used_at).toBe(new Date(1_717_864_414_977).toISOString())
  })
})

describe("AiUsage.buildStepAttributes", () => {
  const step: AiUsage.StepUsage = {
    index: 2,
    tokens: { input: 40, output: 60, reasoning: 5, cache: { read: 10, write: 2 } },
    cost: 0.004,
    at: 1_717_864_414_000,
  }

  test("builds incremental per-step attributes tagged phase:step", () => {
    const attrs = AiUsage.buildStepAttributes(assistant(), step)
    expect(attrs.phase).toBe("step")
    expect(attrs.message_id).toBe("msg_1")
    expect(attrs.step_index).toBe(2)
  })

  test("sums per-step tokens (incremental, not cumulative)", () => {
    // 40 + 60 + 5 + 10 + 2 = 117 — from the STEP usage, not the message total.
    expect(AiUsage.buildStepAttributes(assistant(), step).tokens).toBe(117)
  })

  test("breaks out per-step input/output/reasoning/cache and carries the step fee", () => {
    const attrs = AiUsage.buildStepAttributes(assistant(), step)
    expect(attrs.input).toBe(40)
    expect(attrs.output).toBe(60)
    expect(attrs.reasoning).toBe(5)
    expect(attrs.cache_read).toBe(10)
    expect(attrs.cache_write).toBe(2)
    expect(attrs.cost).toBe(0.004)
  })

  test("uses the step timestamp for used_at, falling back to now", () => {
    expect(AiUsage.buildStepAttributes(assistant(), step).used_at).toBe(new Date(1_717_864_414_000).toISOString())
    const noAt = AiUsage.buildStepAttributes(assistant(), { index: 0, tokens: {}, cost: 0 })
    expect(typeof noAt.used_at).toBe("string")
  })

  test("tolerates missing step token sub-fields", () => {
    const attrs = AiUsage.buildStepAttributes(assistant(), { index: 0, tokens: { input: 3 }, cost: 0 })
    expect(attrs.tokens).toBe(3)
    expect(attrs.output).toBe(0)
    expect(attrs.cache_read).toBe(0)
  })
})
