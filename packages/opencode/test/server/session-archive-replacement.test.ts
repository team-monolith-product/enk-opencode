import { afterEach, describe, expect, test } from "bun:test"
import { GlobalBus } from "../../src/bus/global"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

function activeRoots(directory: string) {
  return Instance.provide({
    directory,
    fn: async () => [...Session.list({ directory, roots: true })].filter((s) => !s.time?.archived),
  })
}

describe("session archive replacement", () => {
  // 같은 세션을 함께 보던 다른 접속자도 새 세션으로 옮겨가려면, 지우기 요청이 끝난 시점에 대체
  // 세션이 이미 있어야 한다 (그래야 session.created 가 전원에게 나간다).
  test("archiving the last session creates a replacement when ensureSession is on", async () => {
    await using tmp = await tmpdir({ config: { ensureSession: true } })
    const app = Server.Default()
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    const listed = await app.request("/session", { headers })
    expect(listed.status).toBe(200)

    const before = await activeRoots(tmp.path)
    expect(before).toHaveLength(1)
    const archived = before[0]!

    const res = await app.request(`/session/${archived.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ time: { archived: Date.now() } }),
    })
    expect(res.status).toBe(200)

    const after = await activeRoots(tmp.path)
    expect(after).toHaveLength(1)
    expect(after[0]!.id).not.toBe(archived.id)
  })

  test("deleting the last session creates a replacement when ensureSession is on", async () => {
    await using tmp = await tmpdir({ config: { ensureSession: true } })
    const app = Server.Default()
    const headers = { "x-opencode-directory": tmp.path }

    await app.request("/session", { headers })
    const before = await activeRoots(tmp.path)
    expect(before).toHaveLength(1)
    const removed = before[0]!

    const res = await app.request(`/session/${removed.id}`, { method: "DELETE", headers })
    expect(res.status).toBe(200)

    const after = await activeRoots(tmp.path)
    expect(after).toHaveLength(1)
    expect(after[0]!.id).not.toBe(removed.id)
  })

  // 같은 세션을 함께 보던 사람들이 동시에 지우기를 누르면 보관 요청이 여러 개 온다. 대체 세션이
  // 여러 개 생기면 먼저 받은 쪽과 나중에 받은 쪽이 서로 다른 세션으로 흩어진다.
  test("simultaneous archives of the same session leave exactly one replacement", async () => {
    for (const config of [{ ensureSession: true, ensureOneSession: true }, { ensureSession: true }]) {
      await using tmp = await tmpdir({ config })
      const app = Server.Default()
      const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

      await app.request("/session", { headers })
      const before = await activeRoots(tmp.path)
      expect(before).toHaveLength(1)
      const archived = before[0]!

      const archive = () =>
        app.request(`/session/${archived.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ time: { archived: Date.now() } }),
        })
      const responses = await Promise.all([archive(), archive(), archive()])
      for (const res of responses) expect(res.status).toBe(200)

      const after = await activeRoots(tmp.path)
      expect(after).toHaveLength(1)
      expect(after[0]!.id).not.toBe(archived.id)

      await Instance.disposeAll()
    }
  })

  // 늦게 도착한 보관 요청은 보관 시각을 덮어쓰지도, session.updated 를 다시 뿌리지도 않는다.
  test("archiving an already archived session is ignored", async () => {
    await using tmp = await tmpdir({ config: { ensureSession: true, ensureOneSession: true } })
    const app = Server.Default()
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    await app.request("/session", { headers })
    const target = (await activeRoots(tmp.path))[0]!

    const first = await app.request(`/session/${target.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ time: { archived: 1000 } }),
    })
    expect(first.status).toBe(200)

    const updates: string[] = []
    const listener = (evt: { payload: { type: string; properties?: { info?: { id?: string } } } }) => {
      if (evt.payload.type !== "session.updated") return
      if (evt.payload.properties?.info?.id !== target.id) return
      updates.push(evt.payload.type)
    }
    GlobalBus.on("event", listener)

    try {
      const second = await app.request(`/session/${target.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ time: { archived: 2000 } }),
      })
      expect(second.status).toBe(200)
      expect((await second.json()).time.archived).toBe(1000)
      expect(updates).toHaveLength(0)
    } finally {
      GlobalBus.off("event", listener)
    }

    const after = await activeRoots(tmp.path)
    expect(after).toHaveLength(1)
    expect(after[0]!.id).not.toBe(target.id)
  })

  test("archiving leaves no session behind when ensureSession is off", async () => {
    await using tmp = await tmpdir()
    const app = Server.Default()
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    const created = await Instance.provide({
      directory: tmp.path,
      fn: async () => Session.create({}),
    })

    const res = await app.request(`/session/${created.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ time: { archived: Date.now() } }),
    })
    expect(res.status).toBe(200)

    expect(await activeRoots(tmp.path)).toHaveLength(0)
  })
})
