import { NodeFileSystem } from "@effect/platform-node"
import { ServerProcess } from "@opencode/server/process"
import { afterAll, afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { HttpServer } from "effect/http"
import { JitdaHub } from "../src/services/jitda-hub"
import { JitdaInitialPlan } from "../src/services/jitda-initial-plan"
import { WebUi } from "../src/services/web-ui"
import { it } from "../../core/test/lib/effect"

const ENV = ["ENK_PROJECT_DIRECTORY", "JUPYTERHUB_SERVICE_PREFIX"]
const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]))

afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

const basic = `Basic ${Buffer.from("opencode:secret").toString("base64")}`

// 플러그인 jitda.initial-plan RPC 역할. 어느 위치로 불렸는지 남기고, 정해 둔 출력을 돌려준다.
let output: unknown = { state: "delivered" }
const directories: string[] = []
const rpc = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname !== "/api/rpc/jitda.initial-plan/deliver" || request.headers.get("authorization") !== basic)
      return new Response("not found", { status: 404 })
    directories.push(decodeURIComponent(request.headers.get("x-opencode-directory") ?? ""))
    return Response.json({ output })
  },
})
afterAll(() => rpc.stop(true))

const start = Effect.fnUntraced(function* () {
  const transform = JitdaHub.wrap(yield* WebUi.handler({ assets: { "index.html": "<html></html>" } }), "secret")
  const server = yield* ServerProcess.start<never, never>(
    { hostname: "127.0.0.1", port: 0, password: "secret", database: { path: ":memory:" }, models: { fetch: false } },
    undefined,
    transform,
  )
  JitdaInitialPlan.start(rpc.url.origin, basic)
  return HttpServer.formatAddress(server.address)
}, Effect.provide(NodeFileSystem.layer))

const deliver = (origin: string, query = "?directory=%2Fwork%2Ftutorial-directory", auth = basic) =>
  Effect.promise(async () => {
    const res = await fetch(`${origin}/user/team-1/api/jitda/initial-plan/deliver${query}`, {
      method: "POST",
      headers: { authorization: auth },
    })
    return { status: res.status, body: await res.json() }
  })

describe("POST /api/jitda/initial-plan/deliver", () => {
  it.live("lands in the main event project even when asked from the tutorial", () =>
    Effect.gen(function* () {
      process.env.JUPYTERHUB_SERVICE_PREFIX = "/user/team-1/"
      process.env.ENK_PROJECT_DIRECTORY = "/work/project-directory"
      directories.length = 0
      output = { state: "delivered" }
      const origin = yield* start()

      expect(yield* deliver(origin)).toEqual({ status: 200, body: { state: "delivered" } })
      expect(directories).toEqual(["/work/project-directory"])
    }),
  )

  it.live("uses the requesting directory when no project is configured", () =>
    Effect.gen(function* () {
      process.env.JUPYTERHUB_SERVICE_PREFIX = "/user/team-1/"
      delete process.env.ENK_PROJECT_DIRECTORY
      directories.length = 0
      output = { state: "not_finalized" }
      const origin = yield* start()

      expect(yield* deliver(origin)).toEqual({ status: 200, body: { state: "not_finalized" } })
      expect(directories).toEqual(["/work/tutorial-directory"])
      expect((yield* deliver(origin, "")).status).toBe(400)
    }),
  )

  it.live("answers 503 when rails is not configured and 502 for other failures", () =>
    Effect.gen(function* () {
      process.env.JUPYTERHUB_SERVICE_PREFIX = "/user/team-1/"
      process.env.ENK_PROJECT_DIRECTORY = "/work/project-directory"
      const origin = yield* start()

      output = { error: "rails is not configured", unavailable: true }
      expect(yield* deliver(origin)).toEqual({ status: 503, body: { error: "rails is not configured" } })
      output = { error: "model unavailable" }
      expect(yield* deliver(origin)).toEqual({ status: 502, body: { error: "model unavailable" } })
      output = { state: "weird" }
      expect((yield* deliver(origin)).status).toBe(502)
    }),
  )

  it.live("requires the server credential", () =>
    Effect.gen(function* () {
      process.env.JUPYTERHUB_SERVICE_PREFIX = "/user/team-1/"
      const origin = yield* start()
      expect((yield* deliver(origin, "", "Basic nope")).status).toBe(401)
    }),
  )
})
