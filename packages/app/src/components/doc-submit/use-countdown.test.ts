import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { useCountdown } from "./use-countdown"

// NOTE ON COVERAGE SCOPE
// ----------------------
// This suite covers only useCountdown's *synchronous seeding* — the value `remaining` holds before
// the reactive effect's first run. That seed is the anti-flash fix: a consumer mapping `remaining` to a
// bar width must start at the deadline value, not 0, or a CSS transition renders a left→right sweep on
// the first frame.
//
// The rest of the hook (the rAF decrement loop, the deadline-anchored onExpire one-shot, and the
// reseed/reschedule on deadline change) lives inside `createEffect`. Under this package's unit harness
// (`bun test` + happydom) Solid resolves to its SERVER build, where `createEffect` user-effects are
// never scheduled or flushed — `createRenderEffect` runs, `createEffect` does not. So the effect body
// is intentionally out of scope here; it is exercised end-to-end in the doc-submit e2e/collab paths.
// If the harness ever gains a client Solid runtime, extend this suite to drive the timers.

describe("useCountdown seeding", () => {
  test("seeds remaining from the deadline, not 0", () => {
    createRoot((dispose) => {
      const now = Date.now()
      const remaining = useCountdown(() => now + 10_000)
      expect(remaining()).toBeGreaterThan(9)
      expect(remaining()).toBeLessThanOrEqual(10)
      dispose()
    })
  })

  test("seeds 0 when there is no deadline", () => {
    createRoot((dispose) => {
      const remaining = useCountdown(() => undefined)
      expect(remaining()).toBe(0)
      dispose()
    })
  })

  test("clamps a deadline already in the past to 0", () => {
    createRoot((dispose) => {
      const remaining = useCountdown(() => Date.now() - 5_000)
      expect(remaining()).toBe(0)
      dispose()
    })
  })
})
