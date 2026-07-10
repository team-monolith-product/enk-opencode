import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "../../src/flag/flag"

const KEYS = ["ENK_AI_FALLBACK_MODELS", "ENK_AI_FALLBACK_RETRIES", "ENK_AI_FALLBACK_STICKY_AFTER"] as const

afterEach(() => {
  for (const key of KEYS) delete process.env[key]
})

describe("Flag.nonNegativeNumber", () => {
  test("accepts zero, unlike the positive-only number()", () => {
    process.env["ENK_AI_FALLBACK_RETRIES"] = "0"
    expect(Flag.nonNegativeNumber("ENK_AI_FALLBACK_RETRIES")).toBe(0)
  })

  test("accepts positive integers", () => {
    process.env["ENK_AI_FALLBACK_RETRIES"] = "7"
    expect(Flag.nonNegativeNumber("ENK_AI_FALLBACK_RETRIES")).toBe(7)
  })

  test("rejects negatives, fractions and garbage", () => {
    for (const value of ["-1", "1.5", "abc", " ", "1e3"]) {
      process.env["ENK_AI_FALLBACK_RETRIES"] = value
      expect(Flag.nonNegativeNumber("ENK_AI_FALLBACK_RETRIES")).toBeUndefined()
    }
  })

  test("treats unset and empty as absent", () => {
    delete process.env["ENK_AI_FALLBACK_RETRIES"]
    expect(Flag.nonNegativeNumber("ENK_AI_FALLBACK_RETRIES")).toBeUndefined()
    process.env["ENK_AI_FALLBACK_RETRIES"] = ""
    expect(Flag.nonNegativeNumber("ENK_AI_FALLBACK_RETRIES")).toBeUndefined()
  })
})

describe("Flag fallback settings", () => {
  test("default to 3 when unset", () => {
    expect(Flag.ENK_AI_FALLBACK_RETRIES).toBe(3)
    expect(Flag.ENK_AI_FALLBACK_STICKY_AFTER).toBe(3)
    expect(Flag.ENK_AI_FALLBACK_MODELS).toBeUndefined()
  })

  test("are read at access time, not at module load", () => {
    process.env["ENK_AI_FALLBACK_RETRIES"] = "1"
    process.env["ENK_AI_FALLBACK_STICKY_AFTER"] = "0"
    process.env["ENK_AI_FALLBACK_MODELS"] = '["a/b"]'
    expect(Flag.ENK_AI_FALLBACK_RETRIES).toBe(1)
    expect(Flag.ENK_AI_FALLBACK_STICKY_AFTER).toBe(0)
    expect(Flag.ENK_AI_FALLBACK_MODELS).toBe('["a/b"]')
  })

  test("fall back to the default when the value is not a non-negative integer", () => {
    process.env["ENK_AI_FALLBACK_RETRIES"] = "-2"
    process.env["ENK_AI_FALLBACK_STICKY_AFTER"] = "nope"
    expect(Flag.ENK_AI_FALLBACK_RETRIES).toBe(3)
    expect(Flag.ENK_AI_FALLBACK_STICKY_AFTER).toBe(3)
  })
})
