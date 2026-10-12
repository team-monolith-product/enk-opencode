import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { CostQuota } from "../../src/enk/cost-quota"
import { Log } from "../../src/util/log"

Log.init({ print: false })

const WEEK_RESET = "2026-10-12T00:00:00+09:00"
const MONTH_RESET = "2026-11-01T00:00:00+09:00"

const window = (remaining: number, resets_at: string): CostQuota.Window => ({ remaining, resets_at })

function quota(overrides: Partial<CostQuota.Quota> = {}): CostQuota.Quota {
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

beforeEach(() => CostQuota.reset())

afterEach(() => {
  delete process.env["ENK_HACKATHON_RAILS_URL"]
  delete process.env["ENK_AI_USAGE_TOKEN"]
})

describe("CostQuota.check", () => {
  test("has no quota when rails is not configured", async () => {
    expect(await CostQuota.check()).toBeUndefined()
  })

  test("reports exhausted when rails says a window ran out", async () => {
    const body = quota({ exhausted: true, weekly: window(0, WEEK_RESET), monthly: window(38, MONTH_RESET) })
    await using rails = serve(() => Response.json(body))
    const current = await CostQuota.check()
    expect(current?.exhausted).toBe(true)
    expect(current?.weekly?.remaining).toBe(0)
    expect(rails.requests).toBe(1)
  })

  test("reads only the fields it needs, so extra rails fields are fine", async () => {
    const body = {
      active: true,
      exhausted: false,
      weekly: { ...window(7, WEEK_RESET), limit: 10, used: 3 },
      monthly: null,
    }
    await using rails = serve(() => Response.json(body))
    expect(await CostQuota.check()).toEqual(quota({ weekly: window(7, WEEK_RESET) }))
    expect(rails.requests).toBe(1)
  })

  test("reuses the cached answer within the ttl and asks again after it", async () => {
    await using rails = serve(() => Response.json(quota({ weekly: window(7, WEEK_RESET) })))
    await CostQuota.check(1_000)
    await CostQuota.check(10_000)
    expect(rails.requests).toBe(1)
    await CostQuota.check(31_000)
    expect(rails.requests).toBe(2)
  })

  test("treats 403 (not a team workspace) as no quota", async () => {
    await using rails = serve(() => new Response("", { status: 403 }))
    expect(await CostQuota.check()).toEqual(quota())
    expect(rails.requests).toBe(1)
  })

  test("fails open on a server error and waits the ttl before retrying", async () => {
    await using rails = serve(() => new Response("", { status: 500 }))
    expect((await CostQuota.check(1_000))?.exhausted).toBe(false)
    expect((await CostQuota.check(2_000))?.exhausted).toBe(false)
    expect(rails.requests).toBe(1)
  })

  test("fails open on a malformed body", async () => {
    await using rails = serve(() => Response.json({ weekly: "nope" }))
    expect((await CostQuota.check())?.exhausted).toBe(false)
    expect(rails.requests).toBe(1)
  })

  test("fails open when rails is unreachable", async () => {
    process.env["ENK_HACKATHON_RAILS_URL"] = "http://127.0.0.1:9"
    process.env["ENK_AI_USAGE_TOKEN"] = "team-token"
    expect((await CostQuota.check())?.exhausted).toBe(false)
  })

  test("keeps the last known quota when a refresh fails", async () => {
    let status = 200
    const body = quota({ exhausted: true, weekly: window(0, WEEK_RESET) })
    await using rails = serve(() => (status === 200 ? Response.json(body) : new Response("", { status })))
    expect((await CostQuota.check(1_000))?.exhausted).toBe(true)
    status = 503
    expect((await CostQuota.check(40_000))?.exhausted).toBe(true)
    expect(rails.requests).toBe(2)
  })
})

describe("CostQuota.consume", () => {
  test("spends the cached windows locally so a long turn stops at the limit without another request", async () => {
    await using rails = serve(() =>
      Response.json(quota({ weekly: window(0.1, WEEK_RESET), monthly: window(41, MONTH_RESET) })),
    )
    expect((await CostQuota.check(1_000))?.exhausted).toBe(false)
    CostQuota.consume(0.09)
    expect((await CostQuota.check(2_000))?.exhausted).toBe(false)
    CostQuota.consume(0.01)
    const current = await CostQuota.check(3_000)
    expect(current?.exhausted).toBe(true)
    expect(current?.weekly?.remaining).toBe(0)
    expect(current?.monthly?.remaining).toBeCloseTo(40.9, 6)
    expect(rails.requests).toBe(1)
  })

  test("is a no-op before anything was fetched", () => {
    expect(() => CostQuota.consume(1)).not.toThrow()
  })
})

describe("CostQuota.spend", () => {
  test("returns a new quota and leaves the input untouched", () => {
    const before = quota({ weekly: window(0.1, WEEK_RESET) })
    const after = CostQuota.spend(before, 0.2)
    expect(after).toEqual(quota({ exhausted: true, weekly: window(0, WEEK_RESET) }))
    expect(before).toEqual(quota({ weekly: window(0.1, WEEK_RESET) }))
  })

  test("spends every window and stays open while all have room", () => {
    const after = CostQuota.spend(quota({ weekly: window(5, WEEK_RESET), monthly: window(6, MONTH_RESET) }), 3)
    expect(after).toEqual(quota({ weekly: window(2, WEEK_RESET), monthly: window(3, MONTH_RESET) }))
  })
})

describe("CostQuota.message", () => {
  test("names the weekly window with its KST reset time and never the amount", () => {
    const text = CostQuota.message(quota({ weekly: window(0, WEEK_RESET) }))
    expect(text).toBe("이번 주 AI 사용 한도를 모두 사용했습니다. 10월 12일 (월) 00:00에 다시 사용할 수 있어요.")
  })

  test("prefers the window that resets later when both are exhausted", () => {
    const text = CostQuota.message(quota({ weekly: window(0, WEEK_RESET), monthly: window(0, MONTH_RESET) }))
    expect(text).toContain("이번 달")
    expect(text).toContain("11월 1일")
    expect(text).not.toContain("$")
  })

  test("speaks english for an english session", () => {
    const text = CostQuota.message(quota({ monthly: window(0, MONTH_RESET) }), "en")
    expect(text).toBe("This month's AI usage limit has been used up. It resets on Sun, Nov 1 00:00 (KST).")
  })

  test("is empty when nothing is exhausted", () => {
    expect(CostQuota.message(quota({ weekly: window(1, WEEK_RESET) }))).toBe("")
  })
})
