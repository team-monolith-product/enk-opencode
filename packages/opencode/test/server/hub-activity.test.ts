import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Hono } from "hono"
import { HubActivity } from "../../src/server/hub-activity"

const pkgRoot = path.resolve(import.meta.dir, "../..")

function run(script: string) {
  const result = Bun.spawnSync(["bun", "-e", script], { cwd: pkgRoot, env: { ...process.env } })
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

describe("HubActivity", () => {
  test("hub 환경변수가 없으면 비활성이고 요청을 그대로 통과시킨다", async () => {
    expect(HubActivity.enabled()).toBe(false)
    const app = new Hono().use(HubActivity.track()).post("/session", (c) => c.json({ ok: true }))
    const res = await app.request("/session", { method: "POST" })
    expect(res.status).toBe(200)
  })

  test("사용자 쓰기 요청과 실행 중인 세션만 hub activity 로 보고한다", () => {
    const { stdout, stderr } = run(`
      const posts = []
      let status = 200
      const hub = Bun.serve({
        port: 0,
        async fetch(req) {
          posts.push({ auth: req.headers.get("authorization"), body: await req.json() })
          return new Response(null, { status })
        },
      })
      process.env.JUPYTERHUB_API_URL = "http://hub.invalid/api"
      process.env.JUPYTERHUB_API_TOKEN = "server-token"
      process.env.JUPYTERHUB_USER = "student"
      process.env.JUPYTERHUB_ACTIVITY_URL = "http://127.0.0.1:" + hub.port + "/hub/api/users/student/activity"
      delete process.env.JUPYTERHUB_SERVER_NAME
      const { Hono } = await import("hono")
      const { HubAuth } = await import("./src/server/hub-auth.ts")
      const { HubActivity } = await import("./src/server/hub-activity.ts")
      const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

      assert(HubActivity.enabled(), "expected enabled")
      const app = new Hono()
        .use(HubActivity.track())
        .get("/event", (c) => c.text("stream"))
        .post("/log", (c) => c.json(true))
        .post("/broken", (c) => c.text("no", 500))
        .post("/session", (c) => c.json({ ok: true }))

      await app.request("/event")
      await app.request("/log", { method: "POST" })
      await app.request("/broken", { method: "POST" })
      await app.request("/session", { method: "POST", headers: { [HubAuth.INTERNAL_HEADER]: HubAuth.INTERNAL_TOKEN } })
      await HubActivity.report()
      assert(posts.length === 0, "passive requests reported: " + posts.length)

      const before = Date.now()
      await app.request("/session", { method: "POST" })
      await HubActivity.report()
      assert(posts.length === 1, "expected 1 post, got " + posts.length)
      assert(posts[0].auth === "token server-token", "auth header " + posts[0].auth)
      const reported = Date.parse(posts[0].body.servers[""].last_activity)
      assert(reported >= before - 1000, "stale timestamp " + posts[0].body.servers[""].last_activity)
      assert(posts[0].body.last_activity === posts[0].body.servers[""].last_activity, "user activity mismatch")

      await HubActivity.report()
      assert(posts.length === 1, "unchanged activity re-reported")

      await Bun.sleep(5)
      status = 500
      await app.request("/session", { method: "POST" })
      await HubActivity.report()
      status = 200
      await HubActivity.report()
      assert(posts.length === 3, "rejected report should be retried, got " + posts.length)
      assert(posts[2].body.last_activity === posts[1].body.last_activity, "retry should resend the same timestamp")

      const busy = (sessionID, type) =>
        HubActivity.observe({ directory: "/w", payload: { type: "session.status", properties: { sessionID, status: { type } } } })
      const later = (minutes) => new Date(Date.now() + minutes * 60_000)

      busy("ses_a", "busy")
      await HubActivity.report(later(1))
      await HubActivity.report(later(2))
      assert(posts.length === 5, "busy session should report every tick, got " + posts.length)

      busy("ses_a", "idle")
      await HubActivity.report(later(3))
      assert(posts.length === 5, "idle session still reported")

      busy("ses_b", "busy")
      HubActivity.observe({ directory: "/w", payload: { type: "server.instance.disposed", properties: { directory: "/w" } } })
      await HubActivity.report(later(4))
      assert(posts.length === 5, "disposed instance still counted busy")

      hub.stop(true)
      console.log("OK")
    `)
    expect(stderr).not.toContain("Error")
    expect(stdout).toContain("OK")
  })
})
