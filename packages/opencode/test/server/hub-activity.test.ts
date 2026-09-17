import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Hono } from "hono"
import { HubActivity } from "../../src/server/hub-activity"

const pkgRoot = path.resolve(import.meta.dir, "../..")

describe("HubActivity", () => {
  test("hub 환경변수가 없으면 비활성이고 요청을 그대로 통과시킨다", async () => {
    expect(HubActivity.enabled()).toBe(false)
    const app = new Hono().use(HubActivity.track()).get("/session/status", (c) => c.json({}))
    const res = await app.request("/session/status")
    expect(res.status).toBe(200)
  })

  test("jupyter-server 와 같은 기준으로 활동을 기록해 hub 에 보고한다", () => {
    const script = `
      const posts = []
      let failures = 0
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
      process.env.JUPYTERHUB_API_URL = "http://hub.invalid/api"
      process.env.JUPYTERHUB_API_TOKEN = "server-token"
      process.env.JUPYTERHUB_USER = "student"
      process.env.JUPYTERHUB_ACTIVITY_URL = "http://127.0.0.1:" + hub.port + "/hub/api/users/student/activity"
      delete process.env.JUPYTERHUB_SERVER_NAME
      delete process.env.JUPYTERHUB_ACTIVITY_INTERVAL
      const { Hono } = await import("hono")
      const { streamSSE } = await import("hono/streaming")
      const { HubAuth } = await import("./src/server/hub-auth.ts")
      const { HubActivity } = await import("./src/server/hub-activity.ts")
      const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

      assert(HubActivity.enabled(), "expected enabled")
      const app = new Hono()
        .use(HubActivity.track())
        .get("/event", (c) => streamSSE(c, async (stream) => stream.writeSSE({ data: "x" })))
        .get("/global/health", (c) => {
          HubActivity.untrack(c.req.raw)
          return c.json({ healthy: true })
        })
        .get("/session/status", (c) => c.json({}))
        .post("/broken", (c) => c.text("no", 500))
        .all("/*", (c) => {
          HubActivity.untrack(c.req.raw)
          return c.html("<html></html>")
        })

      const latest = async () => {
        await HubActivity.report()
        return posts.at(-1).body.last_activity
      }
      const request = async (url, init) => {
        await Bun.sleep(5)
        await app.request(url, init)
      }

      const started = await latest()
      assert(posts[0].auth === "token server-token", "auth header " + posts[0].auth)
      assert(posts[0].body.servers[""].last_activity === started, "server activity mismatch")
      assert((await latest()) === started, "unchanged activity should be re-sent as is")
      assert(posts.length === 2, "expected a post per report, got " + posts.length)

      await request("/event")
      await request("/global/health")
      await request("/assets/app.js")
      await request("/session/status?no_track_activity=1")
      await request("/session/status", { method: "OPTIONS" })
      await request("/session/status", { headers: { [HubAuth.INTERNAL_HEADER]: HubAuth.INTERNAL_TOKEN } })
      await request("/session/status", { headers: { upgrade: "websocket" } })
      assert((await latest()) === started, "untracked requests recorded activity")

      await request("/session/status")
      const polled = await latest()
      assert(polled > started, "GET api request should record activity")

      await request("/broken", { method: "POST" })
      const failed = await latest()
      assert(failed > polled, "error response should record activity")

      const event = (type, properties = {}) => HubActivity.observe({ directory: "/w", payload: { type, properties } })
      const quiet = async (label) => {
        const before = await latest()
        await Bun.sleep(5)
        event("file.watcher.updated")
        assert((await latest()) === before, label)
      }

      await quiet("event on idle instance recorded activity")
      await Bun.sleep(5)
      event("session.status", { sessionID: "ses_a", status: { type: "busy" } })
      const busy = await latest()
      assert(busy > failed, "status change should record activity")
      await Bun.sleep(5)
      event("message.part.delta")
      const streaming = await latest()
      assert(streaming > busy, "event while busy should record activity")
      await Bun.sleep(5)
      event("session.status", { sessionID: "ses_a", status: { type: "idle" } })
      assert((await latest()) > streaming, "idle status should record activity")
      await quiet("event after idle recorded activity")

      event("session.status", { sessionID: "ses_b", status: { type: "busy" } })
      event("server.instance.disposed", { directory: "/w" })
      await quiet("disposed instance still counted busy")

      const count = posts.length
      failures = 1
      await HubActivity.report()
      assert(posts.length === count + 2, "failed report should be retried, got " + (posts.length - count))
      assert(posts.at(-1).body.last_activity === posts.at(-2).body.last_activity, "retry should resend the same timestamp")

      failures = 1000
      const rejected = await HubActivity.report(0.2).then(() => false, () => true)
      assert(rejected, "report should give up after the timeout")

      hub.stop(true)
      console.log("OK")
    `
    const result = Bun.spawnSync(["bun", "-e", script], { cwd: pkgRoot, env: { ...process.env } })
    const stderr = result.stderr.toString()
    expect(stderr).not.toContain("error:")
    expect(result.stdout.toString()).toContain("OK")
  })
})
