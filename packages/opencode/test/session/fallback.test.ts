import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionFallback } from "../../src/session/fallback"
import { SessionID } from "../../src/session/schema"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const sessionID = SessionID.make("session-fallback-test")
const other = SessionID.make("session-fallback-other")

// The service reads the threshold off the env on every call, so tests can retune it in place.
function stickyAfter(value: string | undefined) {
  if (value === undefined) delete process.env["ENK_AI_FALLBACK_STICKY_AFTER"]
  else process.env["ENK_AI_FALLBACK_STICKY_AFTER"] = value
}

async function run<A>(fn: (svc: SessionFallback.Interface) => Effect.Effect<A>) {
  await using tmp = await tmpdir()
  return Instance.provide({
    directory: tmp.path,
    fn: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* fn(yield* SessionFallback.Service)
        }).pipe(Effect.provide(SessionFallback.layer)),
      ),
  })
}

afterEach(() => stickyAfter(undefined))

describe("SessionFallback", () => {
  test("starts at zero and not degraded", async () => {
    const result = await run((svc) =>
      Effect.gen(function* () {
        return { count: yield* svc.count(sessionID), degraded: yield* svc.degraded(sessionID) }
      }),
    )
    expect(result).toEqual({ count: 0, degraded: false })
  })

  test("degrades once the count reaches the threshold", async () => {
    stickyAfter("3")
    const result = await run((svc) =>
      Effect.gen(function* () {
        const seen: boolean[] = []
        for (let i = 0; i < 3; i++) {
          yield* svc.increment(sessionID)
          seen.push(yield* svc.degraded(sessionID))
        }
        return { seen, count: yield* svc.count(sessionID) }
      }),
    )
    expect(result).toEqual({ seen: [false, false, true], count: 3 })
  })

  test("reset clears degraded mode", async () => {
    stickyAfter("1")
    const result = await run((svc) =>
      Effect.gen(function* () {
        yield* svc.increment(sessionID)
        const before = yield* svc.degraded(sessionID)
        yield* svc.reset(sessionID)
        return { before, after: yield* svc.degraded(sessionID), count: yield* svc.count(sessionID) }
      }),
    )
    expect(result).toEqual({ before: true, after: false, count: 0 })
  })

  test("a threshold of zero degrades immediately", async () => {
    stickyAfter("0")
    expect(await run((svc) => svc.degraded(sessionID))).toBe(true)
  })

  test("counts are per session", async () => {
    stickyAfter("1")
    const result = await run((svc) =>
      Effect.gen(function* () {
        yield* svc.increment(sessionID)
        return { one: yield* svc.degraded(sessionID), two: yield* svc.degraded(other) }
      }),
    )
    expect(result).toEqual({ one: true, two: false })
  })
})
