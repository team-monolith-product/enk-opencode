import { afterEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { CostQuota } from "../../src/enk/cost-quota"
import { InitialPlan } from "../../src/enk/initial-plan"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import type { SessionID } from "../../src/session/schema"
import { Storage } from "../../src/storage/storage"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const PLAN = "# 최초 기획\n\n관찰한 장면 ..."

function chat(text: string) {
  const payload =
    [
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] })}`,
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ delta: { content: text } }] })}`,
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "stop" }] })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"
  return new Response(payload, { status: 200, headers: { "Content-Type": "text/event-stream" } })
}

/** 모델과 hackathon-rails 역할을 한 서버가 맡는다. */
function serve() {
  const results: unknown[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith("/chat/completions")) {
        return chat("구역 표시 → 신청 → 새로고침 확인 순서로 만들어요")
      }
      if (url.pathname === "/api/v1/opencode/initial_plan") return Response.json({ status: "claimed", planning_id: 7 })
      if (url.pathname === "/api/v1/opencode/initial_plan/claim")
        return Response.json({ claimed: true, planning_id: 7, claim_token: "tok-1", prompt: PLAN })
      if (url.pathname === "/api/v1/opencode/initial_plan/result") {
        const body = await req.json()
        if (!body.claim_token) return Response.json({ errors: [{ title: "InvalidResult" }] }, { status: 422 })
        results.push(body)
        return Response.json({ status: body.status, applied: true })
      }
      return new Response("not found", { status: 404 })
    },
  })
  process.env["ENK_HACKATHON_RAILS_URL"] = server.url.origin
  process.env["ENK_AI_USAGE_TOKEN"] = "team-token"
  return { server, results, [Symbol.asyncDispose]: () => server.stop(true) }
}

async function workspace(origin: string) {
  return tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: ["alibaba"],
          provider: { alibaba: { options: { apiKey: "k", baseURL: `${origin}/v1` } } },
          agent: { plan: { model: "alibaba/qwen-plus" }, build: { model: "alibaba/qwen-plus" } },
          ensureOneSession: true,
        }),
      )
    },
  })
}

async function settle(sessionID: SessionID) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if ((await SessionStatus.get(sessionID)).type === "idle") {
      const last = (await Session.messages({ sessionID })).at(-1)
      if (last?.info.role === "assistant" && last.info.time.completed) return
    }
    await Bun.sleep(25)
  }
  throw new Error("session did not settle")
}

async function count(sessionID: SessionID) {
  const msgs = await Session.messages({ sessionID })
  const handoffs = msgs.filter((msg) =>
    msg.parts.some((part) => part.type === "text" && part.metadata?.[InitialPlan.MARKER] === true),
  )
  return {
    handoffs: handoffs.length,
    users: msgs.filter((msg) => msg.info.role === "user").length,
    msgs,
  }
}

afterEach(async () => {
  CostQuota.reset()
  await Storage.remove(["enk", "initial-plan"]).catch(() => undefined)
  await Instance.disposeAll()
  delete process.env["ENK_HACKATHON_RAILS_URL"]
  delete process.env["ENK_AI_USAGE_TOKEN"]
})

describe("initial plan in the main session", () => {
  test("hands the plan to the plan agent once and lets it answer", async () => {
    await using rails = serve()
    await using tmp = await workspace(rails.server.url.origin)
    await Instance.provide({
      directory: tmp.path,
      init: InstanceBootstrap,
      fn: async () => {
        const main = await Session.create({ title: "Main" })
        expect(await InitialPlan.deliver()).toBe("delivered")
        await settle(main.id)
        expect(await InitialPlan.deliver()).toBe("already_delivered")

        const { handoffs, users, msgs } = await count(main.id)
        expect(handoffs).toBe(1)
        expect(users).toBe(1)
        expect(msgs[0]!.info.role === "user" && msgs[0]!.info.agent).toBe("plan")
        expect(rails.results).toEqual([
          { status: "delivered", session_id: main.id, claim_token: "tok-1" },
          { status: "delivered", session_id: main.id, claim_token: "tok-1" },
        ])
      },
    })
  })

  test("does not hand off twice after a crash between sending and recording it", async () => {
    await using rails = serve()
    await using tmp = await workspace(rails.server.url.origin)
    await Instance.provide({
      directory: tmp.path,
      init: InstanceBootstrap,
      fn: async () => {
        const main = await Session.create({ title: "Main" })
        // 앞선 프로세스가 전달 메시지만 남기고 죽은 상태: 이 프로세스의 기억에는 아무것도 없다.
        await SessionPrompt.prompt({
          sessionID: main.id,
          agent: "plan",
          parts: [
            {
              type: "text",
              text: PLAN,
              metadata: { [InitialPlan.MARKER]: true, planningID: "7", claimToken: "tok-1" },
            },
          ],
        })

        expect(await InitialPlan.deliver()).toBe("already_delivered")
        expect(rails.results).toEqual([{ status: "delivered", session_id: main.id, claim_token: "tok-1" }])
        expect((await count(main.id)).handoffs).toBe(1)
      },
    })
  })

  test("ignores a handoff marker whose planning id is not a number", async () => {
    await using rails = serve()
    await using tmp = await workspace(rails.server.url.origin)
    await Instance.provide({
      directory: tmp.path,
      init: InstanceBootstrap,
      fn: async () => {
        const main = await Session.create({ title: "Main" })
        await InitialPlan.send(PLAN, "../7", "tok-1")
        await settle(main.id)
        expect(await InitialPlan.find("7")).toBeUndefined()
      },
    })
  })
})
