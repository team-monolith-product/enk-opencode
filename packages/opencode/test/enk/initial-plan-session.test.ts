import { afterEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { Doc } from "../../src/doc"
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
const START = "제안한 순서로 제작을 시작해줘."

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

/** 모델과 hackathon-rails 역할을 한 서버가 맡는다. model 을 "fail" 로 두면 모델 호출이 실패한다. */
function serve() {
  const results: unknown[] = []
  const state = { model: "ok" as "ok" | "fail" }
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith("/chat/completions")) {
        if (state.model === "fail")
          return Response.json({ error: { message: "bad request", type: "invalid_request_error" } }, { status: 400 })
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
  return { server, results, state, [Symbol.asyncDispose]: () => server.stop(true) }
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
    const state = await InitialPlan.sessionState(sessionID)
    if (state.lastPlanStatus !== "running" && (await SessionStatus.get(sessionID)).type === "idle") {
      const last = (await Session.messages({ sessionID })).at(-1)
      if (last?.info.role === "assistant" && last.info.time.completed) return state
    }
    await Bun.sleep(25)
  }
  throw new Error("session did not settle")
}

async function built(sessionID: SessionID) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const msgs = await Session.messages({ sessionID })
    const last = msgs.at(-1)
    const started = msgs.some((msg) => msg.info.role === "user" && msg.info.agent === "build")
    if (started && last?.info.role === "assistant" && last.info.time.completed) return
    await Bun.sleep(25)
  }
  throw new Error("build did not run")
}

async function count(sessionID: SessionID) {
  const msgs = await Session.messages({ sessionID })
  const handoffs = msgs.filter((msg) =>
    msg.parts.some((part) => part.type === "text" && part.metadata?.[InitialPlan.MARKER] === true),
  )
  return {
    handoffs: handoffs.length,
    users: msgs.filter((msg) => msg.info.role === "user").length,
    assistants: msgs.filter((msg) => msg.info.role === "assistant").length,
    msgs,
  }
}

afterEach(async () => {
  CostQuota.reset()
  await Storage.remove(["enk", "initial-plan"]).catch(() => undefined)
  await Storage.remove(["enk", "initial-plan-build", "7"]).catch(() => undefined)
  await Instance.disposeAll()
  delete process.env["ENK_HACKATHON_RAILS_URL"]
  delete process.env["ENK_AI_USAGE_TOKEN"]
})

describe("initial plan in the main session", () => {
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

  test("reports the plan run and retries a failed one on the same handoff", async () => {
    await using rails = serve()
    await using tmp = await workspace(rails.server.url.origin)
    await Instance.provide({
      directory: tmp.path,
      init: InstanceBootstrap,
      fn: async () => {
        const main = await Session.create({ title: "Main" })
        expect(await InitialPlan.sessionState(main.id)).toEqual({
          handoffMessageID: null,
          planningID: null,
          buildStarted: false,
          lastPlanStatus: null,
        })

        rails.state.model = "fail"
        await InitialPlan.send(PLAN, "7", "tok-1")
        const failed = await settle(main.id)
        expect(failed).toMatchObject({ planningID: "7", buildStarted: false, lastPlanStatus: "error" })

        rails.state.model = "ok"
        await InitialPlan.retry(main.id)
        expect((await InitialPlan.sessionState(main.id)).lastPlanStatus).toBe("running")
        const done = await settle(main.id)
        expect(done).toMatchObject({ handoffMessageID: failed.handoffMessageID, lastPlanStatus: "done" })

        const after = await count(main.id)
        expect(after).toMatchObject({ handoffs: 1, users: 1, assistants: 1 })
        await expect(InitialPlan.retry(main.id)).rejects.toMatchObject({
          data: { message: "initial plan retry is not available" },
        })
      },
    })
  })
})

describe("initial plan build vote", () => {
  test("a solo team starts build once, with the exact text, without rotating the prompt doc", async () => {
    await using rails = serve()
    await using tmp = await workspace(rails.server.url.origin)
    await Instance.provide({
      directory: tmp.path,
      init: InstanceBootstrap,
      fn: async () => {
        const main = await Session.create({ title: "Main" })
        const { docID } = Doc.prompt(main.id)
        const alice = Doc.actorUpsert({ sessionID: main.id, name: "Alice" })

        await InitialPlan.send(PLAN, "7", "tok-1")
        await settle(main.id)

        const state = await Doc.buildSubmitCreate({ sessionID: main.id, docID, actorID: alice.actorID, text: START })
        expect(state).toMatchObject({ targetKind: "build", status: "sent", preview: { text: START, agent: "build" } })

        await built(main.id)
        const { msgs } = await count(main.id)
        const build = msgs.filter((msg) => msg.info.role === "user" && msg.info.agent === "build")
        expect(build).toHaveLength(1)
        expect(build[0].parts.find((part) => part.type === "text")).toMatchObject({ text: START })
        expect(Doc.prompt(main.id).docID).toBe(docID)
        expect((await InitialPlan.sessionState(main.id)).buildStarted).toBe(true)

        await expect(
          Doc.buildSubmitCreate({ sessionID: main.id, docID, actorID: alice.actorID, text: START }),
        ).rejects.toMatchObject({ data: { message: "build already started" } })
      },
    })
  })

  test("a team vote previews the text and sends build only after approval", async () => {
    await using rails = serve()
    await using tmp = await workspace(rails.server.url.origin)
    await Instance.provide({
      directory: tmp.path,
      init: InstanceBootstrap,
      fn: async () => {
        const main = await Session.create({ title: "Main" })
        const { docID } = Doc.prompt(main.id)
        const alice = Doc.actorUpsert({ sessionID: main.id, name: "Alice" })
        const bob = Doc.actorUpsert({ sessionID: main.id, name: "Bob" })
        const stop = Doc.submitConnect({
          sessionID: main.id,
          docID,
          actorID: bob.actorID,
          peer: { send: () => undefined },
        })

        await expect(
          Doc.buildSubmitCreate({ sessionID: main.id, docID, actorID: alice.actorID, text: START }),
        ).rejects.toMatchObject({ data: { message: "no initial plan in this session" } })

        await InitialPlan.send(PLAN, "7", "tok-1")
        await settle(main.id)

        const pending = await Doc.buildSubmitCreate({ sessionID: main.id, docID, actorID: alice.actorID, text: START })
        expect(pending).toMatchObject({
          targetKind: "build",
          status: "pending",
          preview: { text: START, agent: "build" },
        })
        const again = await Doc.buildSubmitCreate({ sessionID: main.id, docID, actorID: bob.actorID, text: "다른 글" })
        expect(again.submitID).toBe(pending.submitID)
        expect((await count(main.id)).users).toBe(1)

        Doc.submitRespond({ sessionID: main.id, submitID: pending.submitID, actorID: bob.actorID, action: "approve" })
        await built(main.id)

        const { msgs } = await count(main.id)
        expect(msgs.filter((msg) => msg.info.role === "user" && msg.info.agent === "build")).toHaveLength(1)
        expect(Doc.prompt(main.id).docID).toBe(docID)
        stop()
      },
    })
  })
})

describe("initial plan guards", () => {
  test("a build vote runs once the teammate who had not agreed leaves", async () => {
    await using rails = serve()
    await using tmp = await workspace(rails.server.url.origin)
    await Instance.provide({
      directory: tmp.path,
      init: InstanceBootstrap,
      fn: async () => {
        const main = await Session.create({ title: "Main" })
        const { docID } = Doc.prompt(main.id)
        const alice = Doc.actorUpsert({ sessionID: main.id, name: "Alice" })
        const bob = Doc.actorUpsert({ sessionID: main.id, name: "Bob" })
        const stopAlice = Doc.submitConnect({
          sessionID: main.id,
          docID,
          actorID: alice.actorID,
          peer: { send: () => undefined },
        })
        const stopBob = Doc.submitConnect({
          sessionID: main.id,
          docID,
          actorID: bob.actorID,
          peer: { send: () => undefined },
        })
        await InitialPlan.send(PLAN, "7", "tok-1")
        await settle(main.id)

        const pending = await Doc.buildSubmitCreate({ sessionID: main.id, docID, actorID: alice.actorID, text: START })
        expect(pending.status).toBe("pending")
        stopBob()
        await Bun.sleep(2_200)
        await built(main.id)
        expect((await InitialPlan.sessionState(main.id)).buildStarted).toBe(true)
        stopAlice()
      },
    })
  }, 20_000)

  test("a build whose message never got created can be started again", async () => {
    await using rails = serve()
    await using tmp = await workspace(rails.server.url.origin)
    await Instance.provide({
      directory: tmp.path,
      init: InstanceBootstrap,
      fn: async () => {
        const main = await Session.create({ title: "Main" })
        const { docID } = Doc.prompt(main.id)
        const alice = Doc.actorUpsert({ sessionID: main.id, name: "Alice" })
        await InitialPlan.send(PLAN, "7", "tok-1")
        await settle(main.id)

        const prompt = spyOn(SessionPrompt, "prompt").mockRejectedValueOnce(new Error("disk full"))
        await Doc.buildSubmitCreate({ sessionID: main.id, docID, actorID: alice.actorID, text: START })
        await Bun.sleep(50)
        prompt.mockRestore()
        expect((await InitialPlan.sessionState(main.id)).buildStarted).toBe(false)

        const again = await Doc.buildSubmitCreate({ sessionID: main.id, docID, actorID: alice.actorID, text: START })
        expect(again.status).toBe("sent")
        await built(main.id)
        expect((await InitialPlan.sessionState(main.id)).buildStarted).toBe(true)
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
        const state = await InitialPlan.sessionState(main.id)
        expect(state.planningID).toBeNull()
        const { docID } = Doc.prompt(main.id)
        const alice = Doc.actorUpsert({ sessionID: main.id, name: "Alice" })
        await expect(
          Doc.buildSubmitCreate({ sessionID: main.id, docID, actorID: alice.actorID, text: START }),
        ).rejects.toMatchObject({ data: { message: "no initial plan in this session" } })
      },
    })
  })
})
