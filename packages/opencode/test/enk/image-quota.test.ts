import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ImageQuota } from "../../src/enk/image-quota"

const ENV_KEYS = ["ENK_HACKATHON_RAILS_URL", "ENK_AI_USAGE_TOKEN", "ENK_IMAGE_GENERATION_LIMIT"]
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
const originalFetch = globalThis.fetch
let calls: string[] = []

function rails(respond: (method: string) => Response) {
  globalThis.fetch = (async (_: unknown, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    calls.push(method)
    return respond(method)
  }) as unknown as typeof fetch
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const known = (limit: number, used: number) => ({
  kind: "known" as const,
  quota: { limit, used, remaining: limit - used },
})

beforeEach(() => {
  calls = []
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

describe("ImageQuota", () => {
  test("is unlimited without rails", () => {
    delete process.env["ENK_HACKATHON_RAILS_URL"]
    expect(ImageQuota.state()).toEqual({ kind: "unlimited" })
  })

  test("answers from the injected limit before rails replies", () => {
    process.env["ENK_IMAGE_GENERATION_LIMIT"] = "10"
    expect(ImageQuota.state()).toEqual(known(10, 0))
  })

  test("is unknown until synced, then keeps what rails returns", async () => {
    rails(() => json(200, { limit: 10, used: 7, remaining: 3 }))
    expect(ImageQuota.state()).toEqual({ kind: "unknown" })
    expect(await ImageQuota.sync()).toEqual(known(10, 7))
    expect(ImageQuota.state()).toEqual(known(10, 7))
  })

  test("the injected limit wins over a stored one", async () => {
    rails(() => json(200, { limit: 10, used: 4, remaining: 6 }))
    await ImageQuota.sync()
    process.env["ENK_IMAGE_GENERATION_LIMIT"] = "20"
    expect(ImageQuota.state()).toEqual(known(20, 4))
  })

  test("init syncs once in the background", async () => {
    rails(() => json(200, { limit: 10, used: 1, remaining: 9 }))
    ImageQuota.init()
    ImageQuota.init()
    await Bun.sleep(10)
    expect(calls).toEqual(["GET"])
    expect(ImageQuota.state()).toEqual(known(10, 1))
  })

  test("reports non-team workspaces as unavailable", async () => {
    rails(() => json(403, {}))
    expect(await ImageQuota.sync()).toEqual({ kind: "unavailable" })
  })

  test("keeps a reservation the run wants to keep", async () => {
    rails(() => json(201, { limit: 10, used: 4, remaining: 6 }))
    const result = await ImageQuota.withReservation("call_1", async (quota) => ({ kept: true, value: quota }))
    expect(result).toEqual({ status: "reserved", value: { limit: 10, used: 4, remaining: 6 } })
    expect(calls).toEqual(["POST"])
    expect(ImageQuota.state()).toEqual(known(10, 4))
  })

  test("gives the slot back when the run does not keep it or throws", async () => {
    rails((method) =>
      method === "POST"
        ? json(201, { limit: 10, used: 4, remaining: 6 })
        : json(200, { limit: 10, used: 3, remaining: 7 }),
    )
    await ImageQuota.withReservation("call_1", async () => ({ kept: false, value: undefined }))
    await expect(
      ImageQuota.withReservation("call_2", async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(calls).toEqual(["POST", "DELETE", "POST", "DELETE"])
    expect(ImageQuota.state()).toEqual(known(10, 3))
  })

  test("does not run when the team used everything", async () => {
    rails(() => json(409, { limit: 10, used: 10, remaining: 0 }))
    let ran = false
    const result = await ImageQuota.withReservation("call_1", async () => {
      ran = true
      return { kept: true, value: undefined }
    })
    expect(result).toEqual({ status: "exhausted", quota: { limit: 10, used: 10, remaining: 0 } })
    expect(ran).toBe(false)
  })
})
