import { Log } from "@/util/log"
import { Flag } from "@/flag/flag"
import { ModelPolicy } from "./model-policy"

/**
 * Fallback model pool: the ordered list of models to try after the primary model
 * exhausts its retries (or fails with an error retrying cannot fix, such as an
 * exhausted credit balance — a different model may still work).
 *
 * Overridable via ENK_AI_FALLBACK_MODELS, a JSON array whose entries are either
 * "provider/model" strings or { model, variant } objects.
 */
export namespace ModelFallback {
  const log = Log.create({ service: "enk.model-fallback" })

  export interface PoolEntry {
    providerID: string
    modelID: string
    variant?: string
  }

  export const DEFAULT_POOL: readonly PoolEntry[] = [
    { providerID: "google", modelID: "gemini-3.5-flash", variant: "high" },
    // MiniMax gets no auto-generated variants; "adaptive" comes from the deployment's provider
    // config, and is dropped at resolve time wherever that config is absent.
    { providerID: "minimax", modelID: "MiniMax-M3", variant: "adaptive" },
    // Deliberately variant-less: ProviderTransform.variants only treats opus-4-6/sonnet-4-6 as
    // adaptive, so any variant on a newer Claude resolves to thinking.budgetTokens, which the
    // Anthropic API rejects from Sonnet 5 on. Unset, the model thinks adaptively on its own.
    { providerID: "anthropic", modelID: "claude-sonnet-5" },
  ]

  /**
   * Directional exclusion pairs: a vision model never falls back to its text partner.
   * Media-carrying turns (images and PDFs) are routed to the vision model
   * (docker/image-model-router-plugin.js), so falling back from it to the text partner would
   * land the attachment on a model that cannot see it.
   * The reverse direction is safe and allowed — the text model falling back to its
   * vision partner just reaches a model that handles text too, which is exactly what a
   * deployment pairing the two wants as its first fallback.
   *
   * On top of this built-in default, the deployment's ENK_AI_MODEL × ENK_AI_IMAGE_MODEL
   * pair (when both are set) is derived automatically, so the routing pair and the
   * fallback exclusion can never drift apart.
   */
  export interface Pair {
    text: string
    vision: string
  }

  export const DEFAULT_PAIRS: readonly Pair[] = [
    { text: "deepseek/deepseek-v4-pro", vision: "minimax/MiniMax-M3" },
  ]

  const modelKey = (model: { providerID: string; modelID: string }) => `${model.providerID}/${model.modelID}`

  export function pairs(): Pair[] {
    const result: Pair[] = [...DEFAULT_PAIRS]
    const primary = ModelPolicy.parseModel(Flag.ENK_AI_MODEL)
    const image = ModelPolicy.parseModel(Flag.ENK_AI_IMAGE_MODEL)
    if (primary && image) {
      const pair = { text: modelKey(primary), vision: modelKey(image) }
      if (pair.text !== pair.vision) result.push(pair)
    }
    return result
  }

  /** True when the turn's primary model is a pair's vision model and the pool entry its text partner. */
  export function excluded(
    primary: { providerID: string; modelID: string },
    entry: PoolEntry,
    pairList: readonly Pair[] = pairs(),
  ): boolean {
    const primaryKey = modelKey(primary)
    const entryKey = modelKey(entry)
    // The same model is deduplication's concern, not the pair rule's.
    if (primaryKey === entryKey) return false
    return pairList.some((pair) => pair.vision === primaryKey && pair.text === entryKey)
  }

  function entry(raw: unknown): PoolEntry | undefined {
    if (typeof raw === "string") {
      const parsed = ModelPolicy.parseModel(raw)
      return parsed ? { ...parsed } : undefined
    }
    if (typeof raw !== "object" || raw === null) return undefined
    const { model, variant } = raw as { model?: unknown; variant?: unknown }
    if (typeof model !== "string") return undefined
    const parsed = ModelPolicy.parseModel(model)
    if (!parsed) return undefined
    return { ...parsed, variant: typeof variant === "string" && variant ? variant : undefined }
  }

  // Every step of every turn asks for the pool, so parse (and warn about) a given value once.
  const cache = new Map<string, readonly PoolEntry[]>()

  /**
   * A malformed value is ignored entirely and the default pool is used, so a typo in the
   * env var degrades to the built-in behavior rather than disabling fallback silently.
   * An explicit "[]" is well-formed and disables fallback.
   */
  export function parsePool(raw: string | undefined): PoolEntry[] {
    if (!raw) return [...DEFAULT_POOL]
    const cached = cache.get(raw)
    if (cached) return cached.map((entry) => ({ ...entry }))
    const parsed = uncached(raw)
    cache.set(raw, parsed)
    return parsed.map((entry) => ({ ...entry }))
  }

  function uncached(raw: string): PoolEntry[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      log.warn("ENK_AI_FALLBACK_MODELS is not valid JSON, using default pool", { raw })
      return [...DEFAULT_POOL]
    }
    if (!Array.isArray(parsed)) {
      log.warn("ENK_AI_FALLBACK_MODELS is not a JSON array, using default pool", { raw })
      return [...DEFAULT_POOL]
    }

    const result: PoolEntry[] = []
    for (const item of parsed) {
      const parsedEntry = entry(item)
      if (!parsedEntry) {
        log.warn("skipping malformed fallback model entry", { entry: item })
        continue
      }
      result.push(parsedEntry)
    }
    return result
  }
}
