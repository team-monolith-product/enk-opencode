import { afterEach, expect, test } from "bun:test"
import { AiUsageReporter } from "@/session/ai-usage-reporter"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.ENK_HACKATHON_RAILS_URL
  delete process.env.ENK_AI_USAGE_TOKEN
  delete process.env.ENK_AI_USAGE_OWNER_TYPE
  delete process.env.ENK_AI_USAGE_OWNER_ID
})

test("reports ai usage with dedicated token", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(null, { status: 200 })
    },
    originalFetch,
  )

  process.env.ENK_HACKATHON_RAILS_URL = "https://hackathon.example.com/"
  process.env.ENK_AI_USAGE_TOKEN = "usage-token"
  process.env.ENK_AI_USAGE_OWNER_TYPE = "Team"
  process.env.ENK_AI_USAGE_OWNER_ID = "42"

  await AiUsageReporter.report({
    model: { id: "gemini-2.5-flash", providerID: "google" } as any,
    tokens: {
      input: 10,
      output: 20,
      reasoning: 3,
      cache: { read: 4, write: 5 },
    },
    cost: 0.00123,
  })

  expect(calls).toHaveLength(1)
  expect(calls[0].url).toBe("https://hackathon.example.com/api/v1/ai_usages")
  expect(calls[0].init?.method).toBe("POST")
  expect(calls[0].init?.headers).toEqual({
    "Authorization": "token usage-token",
    "Content-Type": "application/json",
  })
  expect(JSON.parse(String(calls[0].init?.body))).toEqual({
    data: {
      type: "ai-usages",
      attributes: {
        owner_type: "Team",
        owner_id: "42",
        model_id: "google/gemini-2.5-flash",
        tokens: 42,
        cost: 0.00123,
        activitied_at: expect.any(String),
      },
    },
  })
})

test("skips reporting when required env is missing", async () => {
  const calls: string[] = []
  globalThis.fetch = Object.assign(
    async (url: string | URL | Request) => {
      calls.push(String(url))
      return new Response(null, { status: 200 })
    },
    originalFetch,
  )

  await AiUsageReporter.report({
    model: { id: "gemini-2.5-flash", providerID: "google" } as any,
    tokens: {
      input: 10,
      output: 20,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    cost: 0.00123,
  })

  expect(calls).toHaveLength(0)
})
