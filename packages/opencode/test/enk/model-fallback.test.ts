import { afterEach, beforeEach, describe, expect, test } from "bun:test"
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

describe("ModelFallback exclusion pairs", () => {
  const ENV_KEYS = ["ENK_AI_MODEL", "ENK_AI_IMAGE_MODEL"]
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
    for (const key of ENV_KEYS) delete process.env[key]
  })
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  const deepseek = { providerID: "deepseek", modelID: "deepseek-v4-pro" }
  const minimax = { providerID: "minimax", modelID: "MiniMax-M3" }
  const gemini = { providerID: "google", modelID: "gemini-3.5-flash" }

  test("the built-in pair blocks only the vision → text direction", () => {
    // deepseek (text) falling back to minimax (vision) is allowed: minimax handles text too,
    // and is the deployment's intended first fallback.
    expect(ModelFallback.excluded(deepseek, minimax)).toBe(false)
    // minimax (vision) falling back to deepseek would drop an image turn on a blind model.
    expect(ModelFallback.excluded(minimax, deepseek)).toBe(true)
  })

  test("a primary outside every pair is unaffected", () => {
    expect(ModelFallback.excluded(gemini, minimax)).toBe(false)
    expect(ModelFallback.excluded(gemini, deepseek)).toBe(false)
    expect(ModelFallback.excluded(deepseek, gemini)).toBe(false)
    expect(ModelFallback.excluded(minimax, gemini)).toBe(false)
  })

  test("the same model is not the pair rule's concern", () => {
    expect(ModelFallback.excluded(minimax, { ...minimax })).toBe(false)
  })

  test("the ENK_AI_MODEL × ENK_AI_IMAGE_MODEL pair is derived, vision → text only", () => {
    process.env.ENK_AI_MODEL = "acme/text-model"
    process.env.ENK_AI_IMAGE_MODEL = "acme/vision-model"
    const text = { providerID: "acme", modelID: "text-model" }
    const vision = { providerID: "acme", modelID: "vision-model" }
    expect(ModelFallback.excluded(vision, text)).toBe(true)
    expect(ModelFallback.excluded(text, vision)).toBe(false)
    // the derived pair is additive: the built-in pair still applies
    expect(ModelFallback.excluded(minimax, deepseek)).toBe(true)
  })

  test("no pair is derived when either env is missing or malformed", () => {
    process.env.ENK_AI_MODEL = "acme/text-model"
    expect(ModelFallback.pairs()).toEqual([...ModelFallback.DEFAULT_PAIRS])

    process.env.ENK_AI_IMAGE_MODEL = "not-a-model"
    expect(ModelFallback.pairs()).toEqual([...ModelFallback.DEFAULT_PAIRS])
  })

  test("an env pair naming the same model twice is ignored", () => {
    process.env.ENK_AI_MODEL = "acme/text-model"
    process.env.ENK_AI_IMAGE_MODEL = "acme/text-model"
    expect(ModelFallback.pairs()).toEqual([...ModelFallback.DEFAULT_PAIRS])
  })
})
