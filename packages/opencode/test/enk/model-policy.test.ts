import { describe, expect, test } from "bun:test"
import { ModelPolicy } from "../../src/enk/model-policy"

describe("ModelPolicy", () => {
  test("parseModel accepts provider/model", () => {
    expect(ModelPolicy.parseModel("anthropic/claude-sonnet-4")).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4",
    })
  })

  test("parseModel rejects invalid input", () => {
    expect(ModelPolicy.parseModel(undefined)).toBeUndefined()
    expect(ModelPolicy.parseModel("anthropic")).toBeUndefined()
    expect(ModelPolicy.parseModel("/model")).toBeUndefined()
    expect(ModelPolicy.parseModel("provider/")).toBeUndefined()
  })

  test("validVariant returns variant when present in variants", () => {
    const variants = { low: {}, high: {} }
    expect(ModelPolicy.validVariant(variants, "high")).toBe("high")
    expect(ModelPolicy.validVariant(variants, "xhigh")).toBeUndefined()
    expect(ModelPolicy.validVariant(undefined, "high")).toBeUndefined()
  })
})
