import { NodeFileSystem } from "@effect/platform-node"
import { ServerProcess } from "@opencode/server/process"
import { Sentry } from "@opencode/plugin-jitda/sentry"
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test"
import { Cause, Effect } from "effect"
import { HttpServer, HttpServerError, HttpServerRequest } from "effect/http"
import { BootEnv } from "../src/boot-env"
import { JitdaHub } from "../src/services/jitda-hub"
import { WebUi } from "../src/services/web-ui"
import { it } from "../../core/test/lib/effect"

const HUB_ENV = [
  "JUPYTERHUB_API_URL",
  "JUPYTERHUB_API_TOKEN",
  "JUPYTERHUB_USER",
  "JUPYTERHUB_CLIENT_ID",
  "JUPYTERHUB_BASE_URL",
  "JUPYTERHUB_SERVICE_PREFIX",
  "JUPYTERHUB_OAUTH_CALLBACK_URL",
  "OPENCODE_SERVE_DOMAIN",
]
const saved = Object.fromEntries(HUB_ENV.map((name) => [name, process.env[name]]))

afterEach(() => {
  for (const name of HUB_ENV) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

const hubUser = { name: "team-1" }
const hub = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/hub/api/oauth2/token") return Response.json({ access_token: "access" })
    if (url.pathname === "/hub/api/user") return Response.json(hubUser)
    return new Response(null, { status: 404 })
  },
})
afterAll(() => hub.stop(true))

const assets = {
  "index.html": '<html><head><link rel="manifest" href="/site.webmanifest" /></head><body>shell</body></html>',
  "_assets/app.js": "console.log('app')",
}

function enableHub() {
  process.env.JUPYTERHUB_API_URL = `http://127.0.0.1:${hub.port}/hub/api`
  process.env.JUPYTERHUB_API_TOKEN = "api-token"
  process.env.JUPYTERHUB_USER = "team-1"
  process.env.JUPYTERHUB_CLIENT_ID = "jupyterhub-user-team-1"
  process.env.JUPYTERHUB_BASE_URL = "/"
  process.env.JUPYTERHUB_SERVICE_PREFIX = "/user/team-1/"
  process.env.JUPYTERHUB_OAUTH_CALLBACK_URL = "http://hub.test/user/team-1/oauth_callback"
}

const start = Effect.fnUntraced(function* () {
  const transform = JitdaHub.wrap(yield* WebUi.handler({ assets }), "secret")
  const server = yield* ServerProcess.start<never, never>(
    { hostname: "127.0.0.1", port: 0, password: "secret", database: { path: ":memory:" }, models: { fetch: false } },
    undefined,
    transform,
  )
  return HttpServer.formatAddress(server.address)
}, Effect.provide(NodeFileSystem.layer))

const basic = `Basic ${Buffer.from("opencode:secret").toString("base64")}`

describe("jitda hub", () => {
  test("injects the base element and relative links under a prefix", () => {
    process.env.JUPYTERHUB_SERVICE_PREFIX = "/user/team-1/"
    expect(JitdaHub.html(assets["index.html"])).toBe(
      '<html><head>\n    <base href="/user/team-1/" /><link rel="manifest" href="site.webmanifest" /></head><body>shell</body></html>',
    )
    delete process.env.JUPYTERHUB_SERVICE_PREFIX
    expect(JitdaHub.html(assets["index.html"])).toBe(assets["index.html"])
  })

  test("builds the Jitda CSP only when a serve domain is configured", () => {
    delete process.env.OPENCODE_SERVE_DOMAIN
    expect(JitdaHub.csp()).toBeUndefined()
    process.env.OPENCODE_SERVE_DOMAIN = "jitda.test"
    process.env.JUPYTERHUB_USER = "team-1"
    const value = JitdaHub.csp("abc")!
    expect(value).toContain("frame-ancestors 'self' jitda.test")
    expect(value).toContain(
      "frame-src 'self' https://team-1.jitda.test https://team-1-tutorial.jitda.test https://user.jitda.test",
    )
    expect(value).toContain("script-src 'self' 'wasm-unsafe-eval' 'sha256-abc'")
  })

  test("tracks busy sessions from status events", () => {
    const busy = new Set<string>()
    JitdaHub.observe(busy, { type: "session.status", data: { sessionID: "a", status: { type: "busy" } } })
    expect([...busy]).toEqual(["a"])
    JitdaHub.observe(busy, { type: "session.status", data: { sessionID: "a", status: { type: "idle" } } })
    expect(busy.size).toBe(0)
    JitdaHub.observe(busy, { type: "session.status", data: { sessionID: "b", status: { type: "retry" } } })
    JitdaHub.observe(busy, { type: "server.connected", data: {} })
    expect(busy.size).toBe(0)
  })

  test("restores boot secrets and removes the file", async () => {
    const file = `${process.env.TMPDIR ?? "/tmp"}/jitda-boot-${crypto.randomUUID()}.env`
    await Bun.write(file, `SECRET_TOKEN ${Buffer.from("a b\nc").toString("base64")}\n`)
    const env: NodeJS.ProcessEnv = {}
    expect(BootEnv.load(file, env)).toEqual(["SECRET_TOKEN"])
    expect(env.SECRET_TOKEN).toBe("a b\nc")
    expect(await Bun.file(file).exists()).toBe(false)
  })

  it.live("serves the shell and API under the service prefix", () =>
    Effect.gen(function* () {
      process.env.JUPYTERHUB_SERVICE_PREFIX = "/user/team-1/"
      const origin = yield* start()
      const shell = yield* Effect.promise(() => fetch(`${origin}/user/team-1/session/abc`))
      expect(shell.status).toBe(200)
      expect(yield* Effect.promise(() => shell.text())).toContain('<base href="/user/team-1/" />')
      const asset = yield* Effect.promise(() => fetch(`${origin}/user/team-1/_assets/app.js`))
      expect(yield* Effect.promise(() => asset.text())).toBe("console.log('app')")
      const api = yield* Effect.promise(() =>
        fetch(`${origin}/user/team-1/api/project`, { headers: { authorization: basic } }),
      )
      expect(api.status).toBe(200)
    }),
  )

  it.live("signs the hub owner in and rejects other hub users", () =>
    Effect.gen(function* () {
      enableHub()
      const origin = yield* start()
      const unauthenticated = yield* Effect.promise(() =>
        fetch(`${origin}/user/team-1/api/project`, { headers: { "sec-fetch-mode": "cors" } }),
      )
      expect(unauthenticated.status).toBe(401)

      const login = yield* Effect.promise(() =>
        fetch(`${origin}/user/team-1/settings?user=u1||Alice`, {
          redirect: "manual",
          headers: { "sec-fetch-mode": "navigate" },
        }),
      )
      expect(login.status).toBe(302)
      const authorize = new URL(login.headers.get("location")!, "http://hub.test")
      expect(authorize.pathname).toBe("/hub/api/oauth2/authorize")
      expect(authorize.searchParams.get("redirect_uri")).toBe("http://hub.test/user/team-1/oauth_callback")
      const state = authorize.searchParams.get("state")!
      const csrf = login.headers.getSetCookie().find((cookie) => cookie.startsWith("opencode-hub-state="))!.split(";")[0]

      const forged = yield* Effect.promise(() =>
        fetch(`${origin}/user/team-1/oauth_callback?code=c&state=forged`, { headers: { cookie: csrf } }),
      )
      expect(forged.status).toBe(400)

      const callback = yield* Effect.promise(() =>
        fetch(`${origin}/user/team-1/oauth_callback?code=c&state=${state}`, {
          redirect: "manual",
          headers: { cookie: csrf },
        }),
      )
      expect(callback.status).toBe(302)
      expect(callback.headers.get("location")).toBe("/user/team-1/settings?user=u1||Alice")
      const session = callback.headers.getSetCookie().find((cookie) => cookie.startsWith("opencode-hub-session="))!
      const api = yield* Effect.promise(() =>
        fetch(`${origin}/user/team-1/api/project`, { headers: { cookie: session.split(";")[0] } }),
      )
      expect(api.status).toBe(200)

      hubUser.name = "intruder"
      const second = yield* Effect.promise(() =>
        fetch(`${origin}/user/team-1/`, { redirect: "manual", headers: { "sec-fetch-mode": "navigate" } }),
      )
      const secondState = new URL(second.headers.get("location")!, "http://hub.test").searchParams.get("state")!
      const secondCsrf = second.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith("opencode-hub-state="))!
        .split(";")[0]
      const denied = yield* Effect.promise(() =>
        fetch(`${origin}/user/team-1/oauth_callback?code=c&state=${secondState}`, { headers: { cookie: secondCsrf } }),
      )
      expect(denied.status).toBe(403)
      hubUser.name = "team-1"
    }),
  )
})

describe("JitdaHub.capture", () => {
  const request = HttpServerRequest.fromWeb(new Request("http://localhost/api/session?x=1", { method: "POST" }))

  test("unknown failures that become 500 go to Sentry with the path and method", async () => {
    const sent = spyOn(Sentry, "captureException").mockImplementation(() => {})
    try {
      const error = new Error("boom")
      await Effect.runPromise(JitdaHub.capture(request, Cause.die(error)))

      expect(sent).toHaveBeenCalledTimes(1)
      expect(sent.mock.calls[0]).toEqual([error, { path: "/api/session", method: "POST" }])
    } finally {
      sent.mockRestore()
    }
  })

  test("intended 4xx failures and dropped connections stay out of Sentry", async () => {
    const sent = spyOn(Sentry, "captureException").mockImplementation(() => {})
    try {
      const missing = new HttpServerError.HttpServerError({ reason: new HttpServerError.RouteNotFound({ request }) })
      await Effect.runPromise(JitdaHub.capture(request, Cause.fail(missing)))
      await Effect.runPromise(JitdaHub.capture(request, Cause.interrupt()))

      expect(sent).not.toHaveBeenCalled()
    } finally {
      sent.mockRestore()
    }
  })
})
