import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

type Sent = { messages: { role: string; content: unknown }[] }

function llm() {
  const sent: Sent[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      sent.push((await req.json()) as Sent)
      const content = JSON.stringify({ title: "Daylist", description: "d", usage: "u" })
      return Response.json({
        id: "c",
        object: "chat.completion",
        created: 0,
        model: "qwen-plus",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    },
  })
  return { server, sent, [Symbol.asyncDispose]: () => server.stop(true) }
}

async function workspace(origin: string) {
  const tmp = await tmpdir({ git: true })
  await Bun.write(
    path.join(tmp.path, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      enabled_providers: ["alibaba"],
      provider: { alibaba: { options: { apiKey: "k", baseURL: `${origin}/v1` } } },
      model: "alibaba/qwen-plus",
    }),
  )
  await Bun.write(path.join(tmp.path, "README.md"), "# Daylist\n할 일 목록 앱")
  return tmp
}

async function say(sessionID: SessionID, text: string, locale?: "ko" | "en") {
  const id = MessageID.ascending()
  await Session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "alibaba", modelID: "qwen-plus" },
    locale,
    tools: {},
  } as unknown as MessageV2.Info)
  await Session.updatePart({ id: PartID.ascending(), sessionID, messageID: id, type: "text", text })
}

function text(sent: Sent) {
  return sent.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n")
}

async function generate(directory: string, body: Record<string, unknown>) {
  return Instance.provide({
    directory,
    fn: () =>
      Server.Default().request("/project-summary/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-opencode-directory": directory },
        body: JSON.stringify(body),
      }),
  })
}

describe("POST /project-summary/generate", () => {
  test("요청 locale 이 en 이면 한국어 대화여도 영어로 쓰라고 지시한다", async () => {
    await using model = llm()
    await using tmp = await workspace(model.server.url.origin)
    const session = await Instance.provide({ directory: tmp.path, fn: () => Session.create({}) })
    await Instance.provide({ directory: tmp.path, fn: () => say(session.id, "할 일 앱 만들어줘", "ko") })

    const res = await generate(tmp.path, { sessionID: session.id, locale: "en" })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ title: "Daylist", description: "d", usage: "u" })
    expect(model.sent).toHaveLength(1)
    const prompt = text(model.sent[0])
    expect(prompt).toContain("Write title, description and usage in English")
    expect(prompt).not.toContain("한국어로 씁니다")
    expect(prompt).not.toContain("transcript 의 언어와 같은 언어로")
  })

  test("요청 locale 이 없으면 마지막 user 메시지의 locale 을 따른다", async () => {
    await using model = llm()
    await using tmp = await workspace(model.server.url.origin)
    const session = await Instance.provide({ directory: tmp.path, fn: () => Session.create({}) })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await say(session.id, "할 일 앱 만들어줘", "ko")
        await say(session.id, "add a filter", "en")
      },
    })

    const res = await generate(tmp.path, { sessionID: session.id })

    expect(res.status).toBe(200)
    expect(text(model.sent[0])).toContain("in English")
  })

  test("아무 단서도 없으면 한국어로 쓰라고 지시한다", async () => {
    await using model = llm()
    await using tmp = await workspace(model.server.url.origin)
    const session = await Instance.provide({ directory: tmp.path, fn: () => Session.create({}) })
    await Instance.provide({ directory: tmp.path, fn: () => say(session.id, "make a todo app") })

    const res = await generate(tmp.path, { sessionID: session.id })

    expect(res.status).toBe(200)
    const prompt = text(model.sent[0])
    expect(prompt).toContain("한국어로 씁니다")
    expect(prompt).not.toContain("in English")
  })

  test("지원하지 않는 locale 은 400 으로 거절한다", async () => {
    await using model = llm()
    await using tmp = await workspace(model.server.url.origin)
    const session = await Instance.provide({ directory: tmp.path, fn: () => Session.create({}) })

    const res = await generate(tmp.path, { sessionID: session.id, locale: "ar" })

    expect(res.status).toBe(400)
    expect(model.sent).toHaveLength(0)
  })
})
