import { describe, expect, test } from "bun:test"
import { ModelFallback } from "../../src/enk/model-fallback"

describe("ModelFallback.parsePool", () => {
  test("uses the default pool when unset", () => {
    expect(ModelFallback.parsePool(undefined)).toEqual([...ModelFallback.DEFAULT_POOL])
    expect(ModelFallback.parsePool("")).toEqual([...ModelFallback.DEFAULT_POOL])
  })

  test("accepts a mix of strings and objects", () => {
    expect(
      ModelFallback.parsePool('["anthropic/claude-sonnet-4-6", {"model": "google/gemini-3-pro", "variant": "high"}]'),
    ).toEqual([
      { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      { providerID: "google", modelID: "gemini-3-pro", variant: "high" },
    ])
  })

  test("keeps model ids containing slashes intact", () => {
    expect(ModelFallback.parsePool('["openrouter/anthropic/claude-sonnet-4-6"]')).toEqual([
      { providerID: "openrouter", modelID: "anthropic/claude-sonnet-4-6" },
    ])
  })

  test("an explicit empty array disables fallback", () => {
    expect(ModelFallback.parsePool("[]")).toEqual([])
  })

  test("falls back to the default pool on malformed json", () => {
    expect(ModelFallback.parsePool("{not json")).toEqual([...ModelFallback.DEFAULT_POOL])
  })

  test("falls back to the default pool when the json is not an array", () => {
    expect(ModelFallback.parsePool('{"model": "anthropic/claude-sonnet-4-6"}')).toEqual([...ModelFallback.DEFAULT_POOL])
    expect(ModelFallback.parsePool('"anthropic/claude-sonnet-4-6"')).toEqual([...ModelFallback.DEFAULT_POOL])
  })

  test("skips only the malformed entries of a well-formed array", () => {
    expect(
      ModelFallback.parsePool('["no-slash", "/leading", "trailing/", 42, null, {"variant": "high"}, "google/gemini"]'),
    ).toEqual([{ providerID: "google", modelID: "gemini" }])
  })

  test("ignores a non-string or empty variant", () => {
    expect(ModelFallback.parsePool('[{"model": "google/gemini", "variant": 5}]')).toEqual([
      { providerID: "google", modelID: "gemini", variant: undefined },
    ])
    expect(ModelFallback.parsePool('[{"model": "google/gemini", "variant": ""}]')).toEqual([
      { providerID: "google", modelID: "gemini", variant: undefined },
    ])
  })

  test("does not let a caller mutate the default pool", () => {
    const pool = ModelFallback.parsePool(undefined)
    pool.push({ providerID: "x", modelID: "y" })
    expect(ModelFallback.parsePool(undefined)).toEqual([...ModelFallback.DEFAULT_POOL])
  })
})
