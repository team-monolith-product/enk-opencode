import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { CostQuota } from "../../src/enk/cost-quota"
import { InitialPlan } from "../../src/enk/initial-plan"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Storage } from "../../src/storage/storage"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

type Call = { method: string; path: string; body?: unknown }

type Rails = {
  status: () => object
  claim: () => object
}

/** 팀 pod 가 부르는 hackathon-rails 역할. 받은 요청을 순서대로 남긴다. */
function serve(rails: Rails) {
  const calls: Call[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === "POST" ? await req.json().catch(() => undefined) : undefined
      calls.push({ method: req.method, path: url.pathname, body })
      if (req.headers.get("authorization") !== "token team-token") return new Response("forbidden", { status: 403 })
      if (url.pathname.endsWith("/chat/completions")) return chat("계획을 정리했어요")
      if (url.pathname === "/api/v1/opencode/initial_plan") return Response.json(rails.status())
      if (url.pathname === "/api/v1/opencode/initial_plan/claim") return Response.json(rails.claim())
      if (url.pathname === "/api/v1/opencode/initial_plan/result") return Response.json({ ok: true })
      return new Response("not found", { status: 404 })
    },
  })
  process.env["ENK_HACKATHON_RAILS_URL"] = server.url.origin
  process.env["ENK_AI_USAGE_TOKEN"] = "team-token"
  return {
    server,
    calls,
    results: () => calls.filter((call) => call.path.endsWith("/result")).map((call) => call.body),
    claims: () => calls.filter((call) => call.path.endsWith("/claim")).length,
    [Symbol.asyncDispose]: () => server.stop(true),
  }
}

function chat(text: string) {
  const payload =
    [
      `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] })}`,
      `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ delta: { content: text } }] })}`,
      `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "stop" }] })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"
  return new Response(payload, { status: 200, headers: { "Content-Type": "text/event-stream" } })
}

const deps = (send: InitialPlan.Deps["send"], find: InitialPlan.Deps["find"] = async () => undefined) => ({
  send,
  find,
})

const claimable: Rails = {
  status: () => ({ status: "pending", planning_id: 7 }),
  claim: () => ({ claimed: true, planning_id: 7, prompt: "# 최초 기획\n\n관찰한 장면 ..." }),
}

afterEach(async () => {
  CostQuota.reset()
  await Storage.remove(["enk", "initial-plan"]).catch(() => undefined)
  await Instance.disposeAll()
  delete process.env["ENK_HACKATHON_RAILS_URL"]
  delete process.env["ENK_AI_USAGE_TOKEN"]
})

describe("InitialPlan.deliver", () => {
  test("claims, hands the rails prompt to the plan agent and reports the session", async () => {
    await using rails = serve(claimable)
    const sent: string[] = []
    const state = await InitialPlan.deliver(
      deps(async (prompt, planningID) => {
        sent.push(`${planningID}:${prompt}`)
        return "ses_main"
      }),
    )

    expect(state).toBe("delivered")
    expect(sent).toEqual(["7:# 최초 기획\n\n관찰한 장면 ..."])
    expect(rails.results()).toEqual([{ status: "delivered", session_id: "ses_main" }])
  })

  test("does nothing before the team finalizes", async () => {
    await using rails = serve({ ...claimable, status: () => ({ status: "none", planning_id: null }) })
    const state = await InitialPlan.deliver(
      deps(async () => {
        throw new Error("must not send")
      }),
    )

    expect(state).toBe("not_finalized")
    expect(rails.claims()).toBe(0)
  })

  test("does not send again once rails has it delivered", async () => {
    await using rails = serve({ ...claimable, status: () => ({ status: "delivered", planning_id: 7 }) })
    const state = await InitialPlan.deliver(
      deps(async () => {
        throw new Error("must not send")
      }),
    )

    expect(state).toBe("already_delivered")
    expect(rails.claims()).toBe(0)
  })

  test("treats a lost claim race to a delivered plan as already delivered", async () => {
    await using rails = serve({ ...claimable, claim: () => ({ claimed: false, status: "delivered" }) })
    const state = await InitialPlan.deliver(
      deps(async () => {
        throw new Error("must not send")
      }),
    )

    expect(state).toBe("already_delivered")
    expect(rails.results()).toEqual([])
  })

  test("reports the failure to rails and lets the next call retry", async () => {
    await using rails = serve(claimable)
    const failed = InitialPlan.deliver(
      deps(async () => {
        throw new Error("model unavailable")
      }),
    )
    await expect(failed).rejects.toThrow("model unavailable")
    expect(rails.results()).toEqual([{ status: "failed", error: "model unavailable" }])

    const retried = await InitialPlan.deliver(deps(async () => "ses_main"))
    expect(retried).toBe("delivered")
    expect(rails.claims()).toBe(2)
  })

  test("re-reports a send whose result never reached rails instead of sending twice", async () => {
    await using rails = serve(claimable)
    let sends = 0
    const send = async () => {
      sends++
      return "ses_main"
    }
    expect(await InitialPlan.deliver(deps(send))).toBe("delivered")
    expect(await InitialPlan.deliver(deps(send))).toBe("already_delivered")

    expect(sends).toBe(1)
    expect(rails.results()).toEqual([
      { status: "delivered", session_id: "ses_main" },
      { status: "delivered", session_id: "ses_main" },
    ])
  })

  test("collapses concurrent requests into a single delivery", async () => {
    await using rails = serve(claimable)
    let sends = 0
    const send = async () => {
      sends++
      await Bun.sleep(20)
      return "ses_main"
    }
    const states = await Promise.all([
      InitialPlan.deliver(deps(send)),
      InitialPlan.deliver(deps(send)),
      InitialPlan.deliver(deps(send)),
    ])

    expect(states).toEqual(["delivered", "delivered", "delivered"])
    expect(sends).toBe(1)
    expect(rails.claims()).toBe(1)
  })

  test("tells the app another delivery holds the claim", async () => {
    await using rails = serve({ ...claimable, claim: () => ({ claimed: false, status: "claimed" }) })
    const state = await InitialPlan.deliver(
      deps(async () => {
        throw new Error("must not send")
      }),
    )

    expect(state).toBe("pending_elsewhere")
    expect(rails.results()).toEqual([])
  })

  test("trusts the session marker over a lost local record", async () => {
    await using rails = serve(claimable)
    const state = await InitialPlan.deliver(
      deps(
        async () => {
          throw new Error("must not send")
        },
        async (planningID) => (planningID === "7" ? "ses_marked" : undefined),
      ),
    )

    expect(state).toBe("already_delivered")
    expect(rails.claims()).toBe(0)
    expect(rails.results()).toEqual([{ status: "delivered", session_id: "ses_marked" }])
  })

  test("refuses when rails is not configured", async () => {
    await expect(InitialPlan.deliver(deps(async () => "ses_main"))).rejects.toBeInstanceOf(InitialPlan.Unavailable)
  })
})

describe("InitialPlan.send", () => {
  test("starts the plan agent in the main session with a marked handoff message", async () => {
    await using rails = serve(claimable)
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: ["alibaba"],
            provider: { alibaba: { options: { apiKey: "test-key", baseURL: `${rails.server.url.origin}/v1` } } },
            agent: { plan: { model: "alibaba/qwen-plus" } },
            ensureOneSession: true,
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const main = await Session.create({ title: "Main" })
        expect(await InitialPlan.deliver()).toBe("delivered")
        expect(rails.results()).toEqual([{ status: "delivered", session_id: main.id }])

        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          const msgs = await Session.messages({ sessionID: main.id })
          const reply = msgs.find((msg) => msg.info.role === "assistant")
          if (reply?.info.role === "assistant" && reply.info.time.completed) break
          await Bun.sleep(25)
        }

        const msgs = await Session.messages({ sessionID: main.id })
        const user = msgs.find((msg) => msg.info.role === "user")
        expect(user?.info.role === "user" && user.info.agent).toBe("plan")
        const part = user?.parts.find((p) => p.type === "text")
        expect(part?.type === "text" && part.metadata).toEqual({ [InitialPlan.MARKER]: true, planningID: "7" })
        const reply = msgs.find((msg) => msg.info.role === "assistant")
        expect(reply?.info.role === "assistant" && reply.info.agent).toBe("plan")
      },
    })
  })
})
