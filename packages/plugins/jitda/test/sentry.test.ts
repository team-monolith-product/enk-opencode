import { describe, expect, test } from "bun:test"
import { Sentry } from "../src/sentry"

describe("Sentry.due", () => {
  test("lets the same key through once per window", () => {
    expect(Sentry.due("due-a", 1000, 0)).toBe(true)
    expect(Sentry.due("due-a", 1000, 999)).toBe(false)
    expect(Sentry.due("due-a", 1000, 1000)).toBe(true)
  })

  test("keeps keys independent", () => {
    expect(Sentry.due("due-b", 1000, 0)).toBe(true)
    expect(Sentry.due("due-c", 1000, 0)).toBe(true)
  })

  test("forgets expired keys once the table grows", () => {
    for (let i = 0; i < 300; i++) Sentry.due(`due-many-${i}`, 10, 0)
    expect(Sentry.tracked()).toBeGreaterThanOrEqual(300)

    expect(Sentry.due("due-after", 10, 20)).toBe(true)

    expect(Sentry.tracked()).toBeLessThan(50)
  })
})

describe("Sentry.init", () => {
  test("stays off outside a JupyterHub pod and when disabled", () => {
    Sentry.init({})
    Sentry.init({ JUPYTERHUB_API_URL: "http://hub/api", OPENCODE_SENTRY_DISABLED: "true" })

    expect(Sentry.isEnabled()).toBe(false)
  })
})
