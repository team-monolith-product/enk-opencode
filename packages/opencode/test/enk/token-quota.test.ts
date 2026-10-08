import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { AiUsage } from "../../src/enk/ai-usage"
import { TokenQuota } from "../../src/enk/token-quota"
import { Log } from "../../src/util/log"

Log.init({ print: false })

const WEEK_RESET = "2026-10-12T00:00:00+09:00"
const MONTH_RESET = "2026-11-01T00:00:00+09:00"

const window = (limit: number, remaining: number, resets_at: string): TokenQuota.Window => ({
  limit,
  remaining,
  resets_at,
})

function quota(overrides: Partial<TokenQuota.Quota> = {}): TokenQuota.Quota {
  return { exhausted: false, weekly: null, monthly: null, ...overrides }
}

/** 팀 pod 가 묻는 hackathon-rails 역할. 응답을 바꿔 가며 요청 횟수를 센다. */
function serve(respond: () => Response) {
  let requests = 0
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      requests++
      return respond()
    },
  })
  process.env["ENK_HACKATHON_RAILS_URL"] = server.url.origin
  process.env["ENK_AI_USAGE_TOKEN"] = "team-token"
  return {
    server,
    get requests() {
      return requests
    },
    [Symbol.asyncDispose]: () => server.stop(true),
  }
}

beforeEach(() => TokenQuota.reset())

afterEach(() => {
  delete process.env["ENK_HACKATHON_RAILS_URL"]
  delete process.env["ENK_AI_USAGE_TOKEN"]
})

describe("TokenQuota.check", () => {
  test("has no quota when rails is not configured", async () => {
    expect(await TokenQuota.check()).toBeUndefined()
  })

  test("reports exhausted when rails says a window ran out", async () => {
    const body = quota({
      exhausted: true,
      weekly: window(1000, 0, WEEK_RESET),
      monthly: window(5000, 3800, MONTH_RESET),
    })
    await using rails = serve(() => Response.json(body))
    const current = await TokenQuota.check()
    expect(current?.exhausted).toBe(true)
    expect(current?.weekly?.remaining).toBe(0)
    expect(rails.requests).toBe(1)
  })

  test("reads only the fields it needs, so extra rails fields are fine", async () => {
    const body = {
      active: true,
      exhausted: false,
      weekly: { ...window(1000, 700, WEEK_RESET), used: 300 },
      monthly: null,
    }
    await using rails = serve(() => Response.json(body))
    expect(await TokenQuota.check()).toEqual(quota({ weekly: window(1000, 700, WEEK_RESET) }))
    expect(rails.requests).toBe(1)
  })

  test("reuses the cached answer within the ttl and asks again after it", async () => {
    await using rails = serve(() => Response.json(quota({ weekly: window(1000, 700, WEEK_RESET) })))
    await TokenQuota.check(1_000)
    await TokenQuota.check(10_000)
    expect(rails.requests).toBe(1)
    await TokenQuota.check(31_000)
    expect(rails.requests).toBe(2)
  })

  test("treats 403 (not a team workspace) as no quota", async () => {
    await using rails = serve(() => new Response("", { status: 403 }))
    expect(await TokenQuota.check()).toEqual(quota())
    expect(rails.requests).toBe(1)
  })

  test("fails open on a server error and waits the ttl before retrying", async () => {
    await using rails = serve(() => new Response("", { status: 500 }))
    expect((await TokenQuota.check(1_000))?.exhausted).toBe(false)
    expect((await TokenQuota.check(2_000))?.exhausted).toBe(false)
    expect(rails.requests).toBe(1)
  })

  test("fails open on a malformed body", async () => {
    await using rails = serve(() => Response.json({ weekly: "nope" }))
    expect((await TokenQuota.check())?.exhausted).toBe(false)
    expect(rails.requests).toBe(1)
  })

  test("fails open when rails is unreachable", async () => {
    process.env["ENK_HACKATHON_RAILS_URL"] = "http://127.0.0.1:9"
    process.env["ENK_AI_USAGE_TOKEN"] = "team-token"
    expect((await TokenQuota.check())?.exhausted).toBe(false)
  })

  test("keeps the last known quota when a refresh fails", async () => {
    let status = 200
    const body = quota({ exhausted: true, weekly: window(1000, 0, WEEK_RESET) })
    await using rails = serve(() => (status === 200 ? Response.json(body) : new Response("", { status })))
    expect((await TokenQuota.check(1_000))?.exhausted).toBe(true)
    status = 503
    expect((await TokenQuota.check(40_000))?.exhausted).toBe(true)
    expect(rails.requests).toBe(2)
  })
})

describe("TokenQuota.consume", () => {
  test("spends the cached windows locally so a long turn stops at the limit without another request", async () => {
    await using rails = serve(() =>
      Response.json(quota({ weekly: window(1000, 100, WEEK_RESET), monthly: window(5000, 4100, MONTH_RESET) })),
    )
    expect((await TokenQuota.check(1_000))?.exhausted).toBe(false)
    TokenQuota.consume(AiUsage.totalTokens({ input: 50, output: 20, reasoning: 5, cache: { read: 10, write: 5 } }))
    expect((await TokenQuota.check(2_000))?.exhausted).toBe(false)
    TokenQuota.consume(AiUsage.totalTokens({ input: 10 }))
    const current = await TokenQuota.check(3_000)
    expect(current?.exhausted).toBe(true)
    expect(current?.weekly).toEqual(window(1000, 0, WEEK_RESET))
    expect(current?.monthly).toEqual(window(5000, 4000, MONTH_RESET))
    expect(rails.requests).toBe(1)
  })

  test("is a no-op before anything was fetched", () => {
    expect(() => TokenQuota.consume(100)).not.toThrow()
  })
})

describe("TokenQuota.spend", () => {
  test("returns a new quota and leaves the input untouched", () => {
    const before = quota({ weekly: window(1000, 10, WEEK_RESET) })
    const after = TokenQuota.spend(before, 20)
    expect(after).toEqual(quota({ exhausted: true, weekly: window(1000, 0, WEEK_RESET) }))
    expect(before).toEqual(quota({ weekly: window(1000, 10, WEEK_RESET) }))
  })

  test("spends every window and stays open while all have room", () => {
    const after = TokenQuota.spend(
      quota({ weekly: window(1000, 50, WEEK_RESET), monthly: window(5000, 60, MONTH_RESET) }),
      30,
    )
    expect(after).toEqual(quota({ weekly: window(1000, 20, WEEK_RESET), monthly: window(5000, 30, MONTH_RESET) }))
  })
})

describe("TokenQuota.message", () => {
  test("names the weekly window with its KST reset time", () => {
    const text = TokenQuota.message(quota({ weekly: window(1_000_000, 0, WEEK_RESET) }))
    expect(text).toContain("이번 주")
    expect(text).toContain("1,000,000")
    expect(text).toContain("10월 12일")
    expect(text).toContain("00:00")
  })

  test("prefers the window that resets later when both are exhausted", () => {
    const text = TokenQuota.message(
      quota({ weekly: window(1000, 0, WEEK_RESET), monthly: window(5000, 0, MONTH_RESET) }),
    )
    expect(text).toContain("이번 달")
    expect(text).toContain("11월 1일")
  })

  test("speaks english for an english session", () => {
    const text = TokenQuota.message(quota({ monthly: window(5000, 0, MONTH_RESET) }), "en")
    expect(text).toContain("This month's")
    expect(text).toContain("5,000")
    expect(text).toContain("Nov 1")
  })

  test("is empty when nothing is exhausted", () => {
    expect(TokenQuota.message(quota({ weekly: window(1000, 10, WEEK_RESET) }))).toBe("")
  })
})
