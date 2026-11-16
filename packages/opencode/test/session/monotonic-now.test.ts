import { afterEach, expect, setSystemTime, test } from "bun:test"
import { monotonicNow } from "../../src/session/prompt"

afterEach(() => setSystemTime())

// loop()'s re-run check orders a prompt's creation against the run's last read; both are stamped with
// this clock, so a system clock stepped back must not reorder them.
test("never goes backward when the system clock is stepped back", () => {
  setSystemTime(new Date(2026, 10, 16, 12, 0, 10))
  const before = monotonicNow()
  setSystemTime(new Date(2026, 10, 16, 12, 0, 5)) // NTP pulls the clock back 5s
  const after = monotonicNow()
  expect(after).toBeGreaterThanOrEqual(before)

  setSystemTime(new Date(2026, 10, 16, 12, 0, 20)) // real time catches up and moves on
  expect(monotonicNow()).toBe(new Date(2026, 10, 16, 12, 0, 20).getTime())
})
