export type PromptLocale = "ko" | "en" | "ar"

export function promptLocale(value?: string | null): PromptLocale | undefined {
  if (value === "ko" || value === "en" || value === "ar") return value
  return undefined
}
