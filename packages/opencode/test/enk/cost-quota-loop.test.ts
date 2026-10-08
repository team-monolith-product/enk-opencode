import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { CostQuota } from "../../src/enk/cost-quota"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
  CostQuota.reset()
  delete process.env["ENK_HACKATHON_RAILS_URL"]
  delete process.env["ENK_AI_USAGE_TOKEN"]
})

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

/** 모델(/chat/completions)과 hackathon-rails(/cost_quota) 역할을 한 서버가 맡는다. */
function serve(quota: CostQuota.Quota) {
  let modelCalls = 0
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith("/chat/completions")) {
        modelCalls++
        return chat("hello from the model")
      }
      if (url.pathname.endsWith("/api/v1/opencode/cost_quota")) return Response.json(quota)
      return new Response("not found", { status: 404 })
    },
  })
  process.env["ENK_HACKATHON_RAILS_URL"] = server.url.origin
  process.env["ENK_AI_USAGE_TOKEN"] = "team-token"
  return {
    server,
    get modelCalls() {
      return modelCalls
    },
    [Symbol.asyncDispose]: () => server.stop(true),
  }
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
          provider: { alibaba: { options: { apiKey: "test-key", baseURL: `${origin}/v1` } } },
          agent: { build: { model: "alibaba/qwen-plus" } },
        }),
      )
    },
  })
}

const weekly = (remaining: number): CostQuota.Window => ({
  limit: 10,
  remaining,
  resets_at: "2026-10-12T00:00:00+09:00",
})

describe("CostQuota in the prompt loop", () => {
  test("closes the turn with the limit notice instead of calling the model", async () => {
    await using rails = serve({ exhausted: true, weekly: weekly(0), monthly: null })
    await using tmp = await workspace(rails.server.url.origin)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const result = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "안녕" }],
        })

        expect(result.info.role).toBe("assistant")
        if (result.info.role !== "assistant") return
        expect(result.info.error?.name).toBe("UnknownError")
        expect(result.info.error?.data.message).toContain("이번 주 AI 사용 한도($10.00)")
        expect(result.info.finish).toBe("stop")

        const msgs = await Session.messages({ sessionID: session.id })
        expect(msgs.filter((msg) => msg.info.role === "assistant")).toHaveLength(1)
        expect(rails.modelCalls).toBe(0)
      },
    })
  })

  test("lets the turn through while the team still has tokens", async () => {
    await using rails = serve({ exhausted: false, weekly: weekly(9.5), monthly: null })
    await using tmp = await workspace(rails.server.url.origin)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // 제목이 있으면 제목 생성 호출이 없어 모델 호출 수가 답변 한 번으로 고정된다.
        const session = await Session.create({ title: "Token quota" })
        const result = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "안녕" }],
        })

        expect(result.info.role).toBe("assistant")
        if (result.info.role !== "assistant") return
        expect(result.info.error).toBeUndefined()
        expect(result.parts.some((part) => part.type === "text" && part.text.includes("hello from the model"))).toBe(
          true,
        )
        expect(rails.modelCalls).toBe(1)
      },
    })
  })
})
