import { describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"

Log.init({ print: false })

describe("GET /global/event", () => {
  test("server.connected 에 서버 시각을 싣는다", async () => {
    const abort = new AbortController()
    const before = Date.now()
    const res = await Server.Default().request("/global/event", { signal: abort.signal })
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    abort.abort()
    await reader.cancel().catch(() => {})

    const line = new TextDecoder().decode(value).split("\n").find((x) => x.startsWith("data:"))!
    const event = JSON.parse(line.slice("data:".length))
    expect(event.payload.type).toBe("server.connected")
    expect(event.payload.properties.time).toBeGreaterThanOrEqual(before)
    expect(event.payload.properties.time).toBeLessThanOrEqual(Date.now())
  })
})
