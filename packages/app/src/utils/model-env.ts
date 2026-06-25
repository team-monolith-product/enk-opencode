export type ModelKey = { providerID: string; modelID: string }

export function parseModel(raw?: string): ModelKey | undefined {
  if (typeof raw !== "string" || !raw) return undefined
  const slash = raw.indexOf("/")
  if (slash <= 0 || slash === raw.length - 1) return undefined
  const providerID = raw.slice(0, slash)
  const modelID = raw.slice(slash + 1)
  if (!providerID || !modelID) return undefined
  return { providerID, modelID }
}

export function resolveVariantLock(input: {
  enk?: string
  vite?: string
  variants?: Record<string, unknown>
}) {
  if (input.enk && input.variants && input.enk in input.variants) return input.enk
  if (input.vite && input.variants && input.vite in input.variants) return input.vite
  return undefined
}
