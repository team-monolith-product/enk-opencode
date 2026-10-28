import { describe, expect, test } from "bun:test"
import { SentryReporter } from "../../src/util/sentry"

describe("SentryReporter.due", () => {
  test("lets the same key through once per window", () => {
    expect(SentryReporter.due("due-a", 1000, 0)).toBe(true)
    expect(SentryReporter.due("due-a", 1000, 999)).toBe(false)
    expect(SentryReporter.due("due-a", 1000, 1000)).toBe(true)
  })

  test("keeps keys independent", () => {
    expect(SentryReporter.due("due-b", 1000, 0)).toBe(true)
    expect(SentryReporter.due("due-c", 1000, 0)).toBe(true)
  })

  test("forgets expired keys once the table grows", () => {
    for (let i = 0; i < 300; i++) SentryReporter.due(`due-many-${i}`, 10, 0)
    expect(SentryReporter.tracked()).toBeGreaterThanOrEqual(300)

    expect(SentryReporter.due("due-after", 10, 20)).toBe(true)

    expect(SentryReporter.tracked()).toBeLessThan(50)
  })
})
