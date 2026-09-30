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

  test("is unavailable when the hub injected no limit", () => {
    expect(ImageQuota.state()).toEqual({ kind: "unavailable" })
  })

  test("never asks rails for the limit", () => {
    process.env["ENK_IMAGE_GENERATION_LIMIT"] = "10"
    rails(() => json(200, { limit: 99, used: 0, remaining: 99 }))
    expect(ImageQuota.state()).toEqual(known(10, 0))
    expect(calls).toEqual([])
  })

  test("uses the injected limit with the used count from rails responses", async () => {
    process.env["ENK_IMAGE_GENERATION_LIMIT"] = "10"
    rails(() => json(201, { limit: 20, used: 4, remaining: 16 }))
    await ImageQuota.withReservation("call_1", async () => ({ kept: true, value: undefined }))
    expect(ImageQuota.state()).toEqual(known(10, 4))
  })

  test("keeps a reservation the run wants to keep", async () => {
    rails(() => json(201, { limit: 10, used: 4, remaining: 6 }))
    const result = await ImageQuota.withReservation("call_1", async (quota) => ({ kept: true, value: quota }))
    expect(result).toEqual({ status: "reserved", value: { limit: 10, used: 4, remaining: 6 } })
    expect(calls).toEqual(["POST"])
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
