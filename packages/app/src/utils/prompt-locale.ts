export type PromptLocale = "ko" | "en"

export function promptLocale(value?: string | null): PromptLocale | undefined {
  if (value === "ko" || value === "en") return value
  return undefined
}
