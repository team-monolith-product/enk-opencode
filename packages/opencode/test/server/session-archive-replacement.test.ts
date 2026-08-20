import { afterEach, describe, expect, test } from "bun:test"
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
