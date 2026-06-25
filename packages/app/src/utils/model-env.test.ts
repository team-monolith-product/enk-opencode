import { describe, expect, test } from "bun:test"
import { parseModel, resolveVariantLock } from "./model-env"

describe("parseModel", () => {
  test("parses provider/model", () => {
    expect(parseModel("anthropic/claude-sonnet-4")).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4",
    })
  })

  test("rejects missing slash", () => {
    expect(parseModel("anthropic")).toBeUndefined()
  })

  test("rejects empty parts", () => {
    expect(parseModel("/model")).toBeUndefined()
    expect(parseModel("provider/")).toBeUndefined()
  })
})

describe("resolveVariantLock", () => {
  const variants = { low: {}, high: {}, medium: {} }

  test("prefers ENK variant over VITE variant", () => {
    expect(resolveVariantLock({ enk: "high", vite: "medium", variants })).toBe("high")
  })

  test("falls back to VITE variant when ENK variant missing", () => {
    expect(resolveVariantLock({ vite: "medium", variants })).toBe("medium")
  })

  test("falls back to VITE variant when ENK variant invalid", () => {
    expect(resolveVariantLock({ enk: "xhigh", vite: "medium", variants })).toBe("medium")
  })

  test("returns undefined when no valid variant", () => {
    expect(resolveVariantLock({ enk: "xhigh", vite: "xhigh", variants })).toBeUndefined()
  })
})
