import { describe, expect, test } from "bun:test"
import { promptLocale } from "./prompt-locale"

describe("promptLocale", () => {
  test("keeps the locales the server understands", () => {
    expect(promptLocale("ko")).toBe("ko")
    expect(promptLocale("en")).toBe("en")
    expect(promptLocale("ar")).toBe("ar")
  })

  test("drops anything else so the server falls back to its default", () => {
    expect(promptLocale("ja")).toBeUndefined()
    expect(promptLocale("ar-SA")).toBeUndefined()
    expect(promptLocale("en-US")).toBeUndefined()
    expect(promptLocale("")).toBeUndefined()
    expect(promptLocale(null)).toBeUndefined()
    expect(promptLocale(undefined)).toBeUndefined()
  })
})
