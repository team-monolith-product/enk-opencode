import { afterEach, describe, expect, test } from "bun:test"
import { GenerateUsage } from "../../src/jitda/generate-usage"

const usage = {
  directory: "/home/jovyan/work",
  modelID: "claude-sonnet",
  tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 300, write: 10 } },
  cost: 0.0123,
}

const env = { url: process.env.ENK_HACKATHON_RAILS_URL, token: process.env.ENK_AI_USAGE_TOKEN }

afterEach(() => {
  process.env.ENK_HACKATHON_RAILS_URL = env.url
  process.env.ENK_AI_USAGE_TOKEN = env.token
  if (env.url === undefined) delete process.env.ENK_HACKATHON_RAILS_URL
  if (env.token === undefined) delete process.env.ENK_AI_USAGE_TOKEN
})

describe("generate usage", () => {
  test("builds a step record outside the model loop", () => {
    expect(GenerateUsage.attributes(usage, "gen_1", Date.parse("2026-10-21T00:00:00Z"))).toEqual({
      mount_path: "/home/jovyan/work",
      model_id: "claude-sonnet",
      message_id: "gen_1",
      step_index: -3,
      phase: "step",
      tokens: 435,
      input: 100,
      output: 20,
      reasoning: 5,
      cache_read: 300,
      cache_write: 10,
      cost: 0.0123,
      used_at: "2026-10-21T00:00:00.000Z",
    })
  })

  test("posts the record to rails", async () => {
    process.env.ENK_HACKATHON_RAILS_URL = "https://rails.test/"
    process.env.ENK_AI_USAGE_TOKEN = "secret"
    const calls: { url: string; init: RequestInit }[] = []
    const send = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(null, { status: 201 })
    }) as unknown as typeof fetch
    await GenerateUsage.report(usage, send)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("https://rails.test/api/v1/ai_usages/do_many")
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("token secret")
    const body = JSON.parse(String(calls[0]!.init.body))
    expect(body.data_to_create[0].type).toBe("ai-usages")
    expect(body.data_to_create[0].attributes.cost).toBe(0.0123)
    expect(body.data_to_create[0].attributes.message_id).toStartWith("gen_")
  })

  test("skips posting without rails credentials", async () => {
    delete process.env.ENK_HACKATHON_RAILS_URL
    delete process.env.ENK_AI_USAGE_TOKEN
    let called = false
    await GenerateUsage.report(usage, (async () => {
      called = true
      return new Response(null)
    }) as unknown as typeof fetch)
    expect(called).toBe(false)
  })
})
