import { describe, expect, test } from "bun:test"
import { Locale } from "../../src/enk/locale"

describe("enk.locale", () => {
  test("falls back to korean when the message carries no locale", () => {
    expect(Locale.directive()).toBe(Locale.directive("ko"))
    expect(Locale.directive()).toContain("한국어")
  })

  test("english directive is written in english only", () => {
    const text = Locale.directive("en")
    expect(text).toContain("English")
    expect(text).not.toMatch(/[가-힣]/)
  })

  test("every directive is a single response_language block", () => {
    for (const locale of Locale.Schema.options) {
      const text = Locale.directive(locale)
      expect(text.startsWith("<response_language>")).toBe(true)
      expect(text.endsWith("</response_language>")).toBe(true)
    }
  })

  test("schema only accepts the locales the host can send", () => {
    expect(Locale.Schema.safeParse("ko").success).toBe(true)
    expect(Locale.Schema.safeParse("en").success).toBe(true)
    expect(Locale.Schema.safeParse("ja").success).toBe(false)
    expect(Locale.Schema.safeParse("en-US").success).toBe(false)
  })
})
