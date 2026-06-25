export namespace ModelPolicy {
  export function parseModel(raw?: string) {
    if (!raw) return undefined
    const slash = raw.indexOf("/")
    if (slash <= 0 || slash === raw.length - 1) return undefined
    const providerID = raw.slice(0, slash)
    const modelID = raw.slice(slash + 1)
    if (!providerID || !modelID) return undefined
    return { providerID, modelID }
  }

  export function validVariant(variants: Record<string, unknown> | undefined, variant?: string) {
    if (!variant || !variants) return undefined
    if (!(variant in variants)) return undefined
    return variant
  }
}
