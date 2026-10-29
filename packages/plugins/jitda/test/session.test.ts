import { describe, expect, test } from "bun:test"
import { Session } from "../src/session"

const info = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  time: {},
  location: { directory: "/p" },
  ...extra,
})

describe("Session main", () => {
  test("reuses the active root session and skips archived and child sessions", async () => {
    const main = Session.createMain({
      list: async () => [info("child", { parentID: "x" }), info("old", { time: { archived: 1 } }), info("main")],
      create: async () => info("new"),
    })
    expect((await main.main()).id).toBe("main")
  })

  test("never hands back the session that was just archived", async () => {
    const main = Session.createMain({ list: async () => [info("archived-now")], create: async () => info("fresh") })
    expect((await main.main("archived-now")).id).toBe("fresh")
  })

  test("concurrent callers share one new session", async () => {
    let created = 0
    const main = Session.createMain({
      list: async () => [],
      create: async () => {
        created++
        await new Promise((resolve) => setTimeout(resolve, 10))
        return info(`s${created}`)
      },
    })
    const results = await Promise.all([main.main(), main.main(), main.main()])
    expect(new Set(results.map((value) => value.id))).toEqual(new Set(["s1"]))
    expect(created).toBe(1)
  })
})
