import { describe, expect, test } from "bun:test"
import { SentryReporter } from "../../src/util/sentry"

describe("SentryReporter.due", () => {
  test("lets the same key through once per window", () => {
    expect(SentryReporter.due("a", 1000, 0)).toBe(true)
    expect(SentryReporter.due("a", 1000, 999)).toBe(false)
    expect(SentryReporter.due("a", 1000, 1000)).toBe(true)
  })

  test("keeps keys independent", () => {
    expect(SentryReporter.due("b", 1000, 0)).toBe(true)
    expect(SentryReporter.due("c", 1000, 0)).toBe(true)
  })
})
