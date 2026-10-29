import { afterEach, describe, expect, test } from "bun:test"
import { InitialPlan } from "../src/initial-plan"

type Call = { method: string; path: string; body?: unknown }

type Rails = {
  status?: () => object
  claim?: () => object
  result?: () => object
}

const PROMPT = "# 최초 기획\n\n관찰한 장면 ..."

/**
 * 팀 pod 가 부르는 hackathon-rails 역할. 받은 요청을 순서대로 남긴다. rails Handoff 처럼 pending 이거나 5분 넘게
 * 결과 없는 claimed 만 다시 점유되고(failed 는 운영 화면의 재시도로 pending 이 돼야 한다), 결과 보고는
 * claim_token 이 없으면 422, 성공은 어느 토큰이든 받고 실패는 지금 점유의 토큰일 때만 반영한다.
 */
function serve(rails: Rails = {}) {
  const calls: Call[] = []
  const handoff = { status: "pending", token: undefined as string | undefined, issued: 0, drop: 0 }
  const status = () => rails.status?.() ?? { status: handoff.status, planning_id: 7 }
  const claim = () => {
    const claimable = handoff.status === "pending"
    const answer = (rails.claim?.() ??
      (claimable ? { claimed: true, planning_id: 7, prompt: PROMPT } : { claimed: false, status: handoff.status })) as {
      claimed: boolean
    }
    if (!answer.claimed) return answer
    handoff.issued++
    handoff.status = "claimed"
    handoff.token = `tok-${handoff.issued}`
    return { ...answer, claim_token: handoff.token }
  }
  const result = (body: { status?: string; claim_token?: string }) => {
    if (!body.claim_token || !["delivered", "failed"].includes(body.status ?? ""))
      return Response.json({ errors: [{ title: "InvalidResult" }] }, { status: 422 })
    if (rails.result) return Response.json(rails.result())
    if (handoff.drop > 0) {
      handoff.drop--
      return new Response("bad gateway", { status: 502 })
    }
    const applied =
      handoff.status !== "delivered" &&
      (body.status === "delivered" || (handoff.status === "claimed" && handoff.token === body.claim_token))
    if (applied) handoff.status = body.status!
    return Response.json({ status: handoff.status, applied })
  }
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === "POST" ? await req.json().catch(() => undefined) : undefined
      calls.push({ method: req.method, path: url.pathname, body })
      if (req.headers.get("authorization") !== "token team-token") return new Response("forbidden", { status: 403 })
      if (url.pathname === "/api/v1/opencode/initial_plan") return Response.json(status())
      if (url.pathname === "/api/v1/opencode/initial_plan/claim") return Response.json(claim())
      if (url.pathname === "/api/v1/opencode/initial_plan/result") return result(body as never)
      return new Response("not found", { status: 404 })
    },
  })
  process.env.ENK_HACKATHON_RAILS_URL = server.url.origin
  process.env.ENK_AI_USAGE_TOKEN = "team-token"
  return {
    results: () => calls.filter((call) => call.path.endsWith("/result")).map((call) => call.body),
    claims: () => calls.filter((call) => call.path.endsWith("/claim")).length,
    retryInRails: () => {
      handoff.status = "pending"
    },
    dropNextResult: () => {
      handoff.drop++
    },
    [Symbol.asyncDispose]: () => server.stop(true),
  }
}

// 플러그인 저장소 역할. 한 테스트 안에서는 여러 deliver 가 같은 기록을 본다.
function memory() {
  let marker: InitialPlan.Marker | undefined
  return {
    stored: async (planningID: string) =>
      marker?.planningID === planningID ? { sessionID: marker.sessionID, claimToken: marker.claimToken } : undefined,
    record: async (value: InitialPlan.Marker) => {
      marker = value
    },
  }
}

function delivery(
  send: InitialPlan.Deps["send"],
  find: InitialPlan.Deps["find"] = async () => undefined,
  store = memory(),
) {
  return InitialPlan.createDelivery({ send, find, ...store })
}

const never: InitialPlan.Deps["send"] = async () => {
  throw new Error("must not send")
}

afterEach(() => {
  delete process.env.ENK_HACKATHON_RAILS_URL
  delete process.env.ENK_AI_USAGE_TOKEN
})

describe("InitialPlan.deliver", () => {
  test("claims, hands the rails prompt to the plan agent and reports the session", async () => {
    await using rails = serve()
    const sent: string[] = []
    const state = await delivery(async (prompt, planningID) => {
      sent.push(`${planningID}:${prompt}`)
      return "ses_main"
    }).deliver()

    expect(state).toBe("delivered")
    expect(sent).toEqual([`7:${PROMPT}`])
    expect(rails.results()).toEqual([{ status: "delivered", session_id: "ses_main", claim_token: "tok-1" }])
  })

  test("does nothing before the team finalizes", async () => {
    await using rails = serve({ status: () => ({ status: "none", planning_id: null }) })
    expect(await delivery(never).deliver()).toBe("not_finalized")
    expect(rails.claims()).toBe(0)
  })

  test("does not send again once rails has it delivered", async () => {
    await using rails = serve({ status: () => ({ status: "delivered", planning_id: 7 }) })
    expect(await delivery(never).deliver()).toBe("already_delivered")
    expect(rails.claims()).toBe(0)
  })

  test("treats a lost claim race to a delivered plan as already delivered", async () => {
    await using rails = serve({ claim: () => ({ claimed: false, status: "delivered" }) })
    expect(await delivery(never).deliver()).toBe("already_delivered")
    expect(rails.results()).toEqual([])
  })

  test("reports the failure and stays failed until rails is asked to retry", async () => {
    await using rails = serve()
    const store = memory()
    const failing = delivery(
      async () => {
        throw new Error("model unavailable")
      },
      undefined,
      store,
    )
    await expect(failing.deliver()).rejects.toThrow("model unavailable")
    expect(rails.results()).toEqual([{ status: "failed", error: "model unavailable", claim_token: "tok-1" }])

    const working = delivery(async () => "ses_main", undefined, store)
    expect(await working.deliver()).toBe("failed")

    rails.retryInRails()
    expect(await working.deliver()).toBe("delivered")
    expect(rails.claims()).toBe(3)
  })

  test("re-reports a send whose result never reached rails instead of sending twice", async () => {
    await using rails = serve()
    let sends = 0
    const plan = delivery(async () => {
      sends++
      return "ses_main"
    })
    rails.dropNextResult()
    await expect(plan.deliver()).rejects.toThrow("responded 502")
    expect(await plan.deliver()).toBe("already_delivered")

    expect(sends).toBe(1)
    expect(rails.results()).toEqual([
      { status: "delivered", session_id: "ses_main", claim_token: "tok-1" },
      { status: "delivered", session_id: "ses_main", claim_token: "tok-1" },
    ])
  })

  test("collapses concurrent requests into a single delivery", async () => {
    await using rails = serve()
    let sends = 0
    const plan = delivery(async () => {
      sends++
      await Bun.sleep(20)
      return "ses_main"
    })
    const states = await Promise.all([plan.deliver(), plan.deliver(), plan.deliver()])

    expect(states).toEqual(["delivered", "delivered", "delivered"])
    expect(sends).toBe(1)
    expect(rails.claims()).toBe(1)
  })

  test("tells the app another delivery holds the claim", async () => {
    await using rails = serve({ claim: () => ({ claimed: false, status: "claimed" }) })
    expect(await delivery(never).deliver()).toBe("pending_elsewhere")
    expect(rails.results()).toEqual([])
  })

  test("trusts the session marker over a lost local record", async () => {
    await using rails = serve()
    const state = await delivery(never, async (planningID) =>
      planningID === "7" ? { sessionID: "ses_marked", claimToken: "tok-old" } : undefined,
    ).deliver()

    expect(state).toBe("already_delivered")
    expect(rails.claims()).toBe(0)
    expect(rails.results()).toEqual([{ status: "delivered", session_id: "ses_marked", claim_token: "tok-old" }])
  })

  test("claims for a token when the session marker has none, then reports without sending again", async () => {
    await using rails = serve()
    const state = await delivery(never, async () => ({ sessionID: "ses_marked" })).deliver()

    expect(state).toBe("already_delivered")
    expect(rails.claims()).toBe(1)
    expect(rails.results()).toEqual([{ status: "delivered", session_id: "ses_marked", claim_token: "tok-1" }])
  })

  test("fails the delivery when rails keeps the plan undelivered", async () => {
    await using rails = serve({ result: () => ({ status: "failed", applied: false }) })
    await expect(delivery(async () => "ses_main").deliver()).rejects.toThrow("rails kept the initial plan failed")
    expect(rails.claims()).toBe(1)
  })

  test("refuses when rails is not configured", async () => {
    await expect(delivery(async () => "ses_main").deliver()).rejects.toBeInstanceOf(InitialPlan.Unavailable)
  })
})

describe("InitialPlan.createFinder", () => {
  const marked = (planningID: unknown, claimToken?: string) => ({
    type: "user",
    metadata: { [InitialPlan.MARKER]: true, planningID, claimToken },
  })

  test("finds the handoff a crashed process left in a root session and remembers it", async () => {
    let scans = 0
    const finder = InitialPlan.createFinder({
      roots: async () => {
        scans++
        return ["ses_other", "ses_main"]
      },
      messages: async (sessionID) =>
        sessionID === "ses_main" ? [{ type: "user" }, marked("7", "tok-1"), { type: "assistant" }] : [],
    })

    expect(await finder.find("7")).toEqual({ sessionID: "ses_main", claimToken: "tok-1" })
    expect(await finder.find("7")).toEqual({ sessionID: "ses_main", claimToken: "tok-1" })
    expect(scans).toBe(1)
  })

  test("ignores a handoff marker whose planning id is not a number", async () => {
    const finder = InitialPlan.createFinder({
      roots: async () => ["ses_main"],
      messages: async () => [marked("../7", "tok-1")],
    })
    expect(await finder.find("7")).toBeUndefined()
  })

  test("prefers what this process just sent over a cached miss", async () => {
    const finder = InitialPlan.createFinder({ roots: async () => [], messages: async () => [] })
    expect(await finder.find("7")).toBeUndefined()
    finder.remember("7", { sessionID: "ses_main", claimToken: "tok-1" })
    expect(await finder.find("7")).toEqual({ sessionID: "ses_main", claimToken: "tok-1" })
  })
})

describe("InitialPlan.start", () => {
  type Handlers = { deliver: () => Promise<InitialPlan.Response> }

  // 플러그인이 쓰는 컨텍스트 면만 흉내 낸다. 메인 세션 하나와 그 대화, 플러그인 저장소.
  function context() {
    const calls: Array<{ name: string; input: unknown }> = []
    const store = new Map<string, unknown>()
    const messages: Array<{ type: string; metadata?: Record<string, unknown> }> = []
    let handlers: Handlers | undefined
    const main = { id: "ses_main", time: {}, location: { directory: "/project" } }
    const ctx = {
      location: { directory: "/project" },
      storage: {
        get: async (key: string) => store.get(key),
        set: async (key: string, value: unknown) => void store.set(key, value),
      },
      rpc: {
        register: async (_definition: unknown, value: Handlers) => {
          handlers = value
          return { dispose: async () => {} }
        },
      },
      session: {
        list: async () => ({ data: [main], cursor: {} }),
        create: async () => {
          throw new Error("must reuse the main session")
        },
        context: async () => messages,
        switchAgent: async (input: unknown) => void calls.push({ name: "switchAgent", input }),
        prompt: async (input: { metadata?: Record<string, unknown> }) => {
          calls.push({ name: "prompt", input })
          messages.push({ type: "user", metadata: input.metadata })
        },
      },
    }
    return { ctx, calls, store, deliver: () => handlers!.deliver() }
  }

  test("switches the main session to plan and leaves a marked prompt without waiting for the answer", async () => {
    await using rails = serve()
    const pod = context()
    await InitialPlan.start(pod.ctx as never)

    expect(await pod.deliver()).toEqual({ state: "delivered" })
    expect(pod.calls).toEqual([
      { name: "switchAgent", input: { sessionID: "ses_main", agent: "plan" } },
      {
        name: "prompt",
        input: {
          sessionID: "ses_main",
          text: PROMPT,
          metadata: { [InitialPlan.MARKER]: true, planningID: "7", claimToken: "tok-1" },
        },
      },
    ])
    expect(pod.store.get("initial-plan")).toEqual({ planningID: "7", sessionID: "ses_main", claimToken: "tok-1" })
    expect(rails.results()).toEqual([{ status: "delivered", session_id: "ses_main", claim_token: "tok-1" }])

    expect(await pod.deliver()).toEqual({ state: "already_delivered" })
    expect(pod.calls.filter((call) => call.name === "prompt")).toHaveLength(1)
  })

  test("answers errors as data so the HTTP route can pick the status", async () => {
    const pod = context()
    await InitialPlan.start(pod.ctx as never)
    expect(await pod.deliver()).toEqual({ error: "rails is not configured", unavailable: true })

    await using _rails = serve({ result: () => ({ status: "failed", applied: false }) })
    expect(await pod.deliver()).toEqual({ error: "rails kept the initial plan failed" })
  })
})
