import { Log } from "@/util/log"
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
    // MiniMax gets no auto-generated variants; "adaptive" comes from the deployment's provider
    // config, and is dropped at resolve time wherever that config is absent.
    { providerID: "minimax", modelID: "MiniMax-M3", variant: "adaptive" },
    { providerID: "google", modelID: "gemini-3.5-flash", variant: "high" },
    { providerID: "anthropic", modelID: "claude-sonnet-4-6", variant: "high" },
  ]

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
