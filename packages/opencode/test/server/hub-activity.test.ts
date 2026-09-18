import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Hono, type MiddlewareHandler } from "hono"
import { streamSSE } from "hono/streaming"
import { HubAuth } from "../../src/server/hub-auth"
import { HubActivity } from "../../src/server/hub-activity"
import { Server } from "../../src/server/server"

const posts: { auth: string | null; body: any }[] = []
let failures = 0
let target: HubActivity.Target

const hub = Bun.serve({
  port: 0,
  async fetch(req) {
    posts.push({ auth: req.headers.get("authorization"), body: await req.json() })
    if (failures > 0) {
      failures--
      return new Response(null, { status: 503 })
    }
    return new Response(null, { status: 200 })
  },
})

beforeAll(() => {
  target = {
    url: `http://127.0.0.1:${hub.port}/hub/api/users/student/activity`,
    token: "server-token",
    server: "",
    interval: 300,
  }
})
afterAll(() => hub.stop(true))

async function reported() {
  await HubActivity.report(target)
  return posts.at(-1)!.body.last_activity as string
}

async function request(app: Hono, url: string, init?: RequestInit) {
  await Bun.sleep(2)
  await app.request(url, init)
}

describe("HubActivity.target", () => {
  test("hub 환경변수가 없으면 보고하지 않는다", () => {
    expect(HubActivity.target()).toBeUndefined()
  })
})

describe("HubActivity.report", () => {
  test("서버 토큰으로 마지막 활동을 보내고, 활동이 없어도 같은 값을 다시 보낸다", async () => {
    const first = await reported()
    expect(posts.at(-1)!.auth).toBe("token server-token")
    expect(posts.at(-1)!.body.servers[""].last_activity).toBe(first)
    expect(await reported()).toBe(first)
  })

  test("hub 가 실패를 돌려주면 같은 값으로 재시도하고, timeout 이 지나면 포기한다", async () => {
    const count = posts.length
    failures = 1
    await HubActivity.report(target)
    expect(posts.length).toBe(count + 2)
    expect(posts.at(-1)!.body.last_activity).toBe(posts.at(-2)!.body.last_activity)

    failures = 1000
    await expect(HubActivity.report(target, 0.2)).rejects.toThrow()
    failures = 0
  })
})

describe("HubActivity.track", () => {
  const app = new Hono()
    .use(HubActivity.track())
    .get("/event", (c) => streamSSE(c, async (stream) => stream.writeSSE({ data: "x" })))
    .get("/session/status", (c) => c.json({}))
    .post("/broken", (c) => c.text("no", 500))
    .all("/ui/*", (c) => {
      HubActivity.untrack(c.req.raw)
      return c.html("<html></html>")
    })

  test("조회·에러 응답 등 인증된 API 요청은 모두 활동이다", async () => {
    const before = await reported()
    await request(app, "/session/status")
    const polled = await reported()
    expect(polled > before).toBe(true)

    await request(app, "/broken", { method: "POST" })
    expect((await reported()) > polled).toBe(true)
  })

  test("SSE·업그레이드·내부 요청·no_track_activity·untrack 한 요청은 활동이 아니다", async () => {
    const before = await reported()
    await request(app, "/event")
    await request(app, "/ui/assets/app.js")
    await request(app, "/session/status?no_track_activity=1")
    await request(app, "/session/status", { method: "OPTIONS" })
    await request(app, "/session/status", { headers: { [HubAuth.INTERNAL_HEADER]: HubAuth.INTERNAL_TOKEN } })
    await request(app, "/session/status", { headers: { upgrade: "websocket" } })
    expect(await reported()).toBe(before)
  })

  test("다른 앱으로 넘긴 요청의 untrack 표시도 유지된다", async () => {
    const ui = new Hono().all("/*", (c) => {
      HubActivity.untrack(c.req.raw)
      return c.html("<html></html>")
    })
    const forward: MiddlewareHandler = async (c) => ui.fetch(c.req.raw, c.env)
    const outer = new Hono().use(HubActivity.track()).use(forward)

    const before = await reported()
    await request(outer, "/")
    expect(await reported()).toBe(before)
  })

  test("실제 서버 조립에서 /global/health 는 활동이 아니다", async () => {
    const control = Server.ControlPlaneRoutes()
    const before = await reported()
    await Bun.sleep(2)
    const res = await control.request("/global/health")
    expect(res.status).toBe(200)
    expect(await reported()).toBe(before)
  })
})

describe("HubActivity.observe", () => {
  const event = (type: string, properties: Record<string, any> = {}) =>
    HubActivity.observe({ directory: "/w", payload: { type, properties } })
  const status = (sessionID: string, type: string) => event("session.status", { sessionID, status: { type } })

  async function quiet() {
    const before = await reported()
    await Bun.sleep(2)
    event("file.watcher.updated")
    return (await reported()) === before
  }

  test("실행 중인 세션이 없으면 다른 이벤트는 활동이 아니다", async () => {
    expect(await quiet()).toBe(true)
  })

  test("세션 상태 변경과 실행 중 이벤트는 활동이다", async () => {
    const before = await reported()
    await Bun.sleep(2)
    status("ses_a", "busy")
    const busy = await reported()
    expect(busy > before).toBe(true)

    await Bun.sleep(2)
    event("message.part.delta")
    const streaming = await reported()
    expect(streaming > busy).toBe(true)

    await Bun.sleep(2)
    status("ses_a", "idle")
    expect((await reported()) > streaming).toBe(true)
    expect(await quiet()).toBe(true)
  })

  test("인스턴스가 정리되면 실행 중 상태도 비운다", async () => {
    status("ses_b", "busy")
    event("server.instance.disposed", { directory: "/w" })
    expect(await quiet()).toBe(true)
  })
})
