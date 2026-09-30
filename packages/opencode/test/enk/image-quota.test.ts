import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ImageQuota } from "../../src/enk/image-quota"

const ENV_KEYS = ["ENK_HACKATHON_RAILS_URL", "ENK_AI_USAGE_TOKEN", "ENK_IMAGE_GENERATION_LIMIT"]
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
const originalFetch = globalThis.fetch
let calls = 0

function rails(respond: () => Response) {
  globalThis.fetch = (async () => {
    calls++
    return respond()
  }) as unknown as typeof fetch
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

beforeEach(() => {
  calls = 0
  process.env["ENK_HACKATHON_RAILS_URL"] = "http://rails/"
  process.env["ENK_AI_USAGE_TOKEN"] = "team-token"
  delete process.env["ENK_IMAGE_GENERATION_LIMIT"]
  ImageQuota.reset()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
})

describe("ImageQuota cache", () => {
  test("answers from the injected limit before rails replies", () => {
    process.env["ENK_IMAGE_GENERATION_LIMIT"] = "10"
    rails(() => new Promise<Response>(() => {}) as never)

    expect(ImageQuota.cached()).toEqual({ limit: 10, used: 0, remaining: 10 })
  })

  test("stores what rails returns when reserving", async () => {
    rails(() => json(201, { limit: 10, used: 4, remaining: 6 }))
    await ImageQuota.reserve("call_1")

    expect(ImageQuota.cached()).toEqual({ limit: 10, used: 4, remaining: 6 })
  })

  test("the injected limit wins over a stored one", async () => {
    rails(() => json(201, { limit: 10, used: 4, remaining: 6 }))
    await ImageQuota.reserve("call_1")
    process.env["ENK_IMAGE_GENERATION_LIMIT"] = "20"

    expect(ImageQuota.cached()).toEqual({ limit: 20, used: 4, remaining: 16 })
  })

  test("syncs from rails once in the background", async () => {
    rails(() => json(200, { limit: 10, used: 7, remaining: 3 }))
    expect(ImageQuota.cached()).toBeUndefined()
    await Bun.sleep(10)

    expect(ImageQuota.cached()).toEqual({ limit: 10, used: 7, remaining: 3 })
    expect(calls).toBe(1)
  })

  test("reports non-team workspaces as unavailable", async () => {
    rails(() => json(403, {}))
    ImageQuota.cached()
    await Bun.sleep(10)

    expect(ImageQuota.cached()).toBeNull()
  })

  test("keeps the released count", async () => {
    rails(() => json(200, { limit: 10, used: 2, remaining: 8 }))
    await ImageQuota.release("call_1")

    expect(ImageQuota.cached()).toEqual({ limit: 10, used: 2, remaining: 8 })
  })
})
