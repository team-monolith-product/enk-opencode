import { describe, expect, test } from "bun:test"
import { Locale } from "../src/locale"

describe("Locale", () => {
  test("accepts ko, en and ar and rejects the rest", () => {
    expect(Locale.parse("ar")).toBe("ar")
    expect(Locale.parse("en")).toBe("en")
    expect(Locale.parse("ko")).toBe("ko")
    expect(Locale.parse("fr")).toBeUndefined()
    expect(Locale.parse(undefined)).toBeUndefined()
  })

  test("arabic directive asks for Arabic unless the user writes in another language", () => {
    const text = Locale.directive("ar")
    expect(text).toContain("Modern Standard Arabic unless the user writes in another language")
    expect(text).toContain("<response_language>")
  })

  test("falls back to Korean without a locale", () => {
    expect(Locale.directive()).toBe(Locale.directive("ko"))
  })
})
