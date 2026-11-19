import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { Hono } from "hono"
import { Viewer } from "../../src/server/viewer"

const pkgRoot = path.resolve(import.meta.dir, "../..")

let rails: ReturnType<typeof Bun.serve>
const seen: { authorization: string | null; body: unknown }[] = []

beforeAll(() => {
  rails = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { ticket?: string }
      seen.push({ authorization: req.headers.get("authorization"), body })
      if (body.ticket !== "good") return Response.json({ errors: [] }, { status: 403 })
      return Response.json({ viewer: { id: "op", name: "운영자" } })
    },
  })
  process.env["ENK_HACKATHON_RAILS_URL"] = `http://localhost:${rails.port}`
  process.env["ENK_AI_USAGE_TOKEN"] = "team-token"
})

afterAll(() => {
  rails.stop(true)
  delete process.env["ENK_HACKATHON_RAILS_URL"]
  delete process.env["ENK_AI_USAGE_TOKEN"]
})

function app() {
  return new Hono()
    .use(Viewer.auth())
    .all("/*", (c) => c.json({ viewer: Viewer.is(c.req.raw) }))
}

async function enter() {
  const res = await app().request("/session/abc?viewer_ticket=good&user=op||운영자")
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? ""
  return { res, cookie }
}

describe("Viewer.auth", () => {
  test("유효한 티켓이면 관전 세션 쿠키를 주고 티켓을 뺀 readonly 주소로 보낸다", async () => {
    const { res, cookie } = await enter()

    expect(res.status).toBe(302)
    expect(cookie).toStartWith("opencode-viewer-session=")
    const location = new URL(res.headers.get("location")!, "http://x")
    expect(location.pathname).toBe("/session/abc")
    expect(location.searchParams.get("viewer_ticket")).toBeNull()
    expect(location.searchParams.get("readonly")).toBe("true")
    expect(location.searchParams.get("user")).toBe("op||운영자")
    expect(seen.at(-1)).toEqual({ authorization: "token team-token", body: { ticket: "good" } })
  })

  test("rails 가 거절한 티켓은 403", async () => {
    const res = await app().request("/?viewer_ticket=bad")
    expect(res.status).toBe(403)
    expect(res.headers.get("set-cookie")).toBeNull()
  })

  test("쿠키 없는 요청은 관전 세션이 아니다", async () => {
    const res = await app().request("/session", { method: "POST" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ viewer: false })
  })

  test("모르는 쿠키는 관전 세션이 아니다", async () => {
    const res = await app().request("/session", { headers: { cookie: "opencode-viewer-session=forged" } })
    expect(await res.json()).toEqual({ viewer: false })
  })

  test("관전 세션은 조회만 통과하고 쓰기·터미널·키 조회는 403", async () => {
    const { cookie } = await enter()
    const call = (url: string, init: RequestInit = {}) =>
      app().request(url, { ...init, headers: { cookie, ...(init.headers ?? {}) } })

    const read = await call("/session/abc/message")
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({ viewer: true })

    expect((await call("/session/abc/message", { method: "POST" })).status).toBe(403)
    expect((await call("/session/abc/abort", { method: "POST" })).status).toBe(403)
    expect((await call("/session/abc", { method: "DELETE" })).status).toBe(403)
    expect((await call("/file/content", { method: "PATCH" })).status).toBe(403)
    expect((await call("/pty")).status).toBe(403)
    expect((await call("/env-file/OPENAI_API_KEY/value")).status).toBe(403)
    expect((await call("/provider/auth")).status).toBe(403)
  })

  test("관전 세션의 웹소켓은 관전용 채널만 열린다", async () => {
    const { cookie } = await enter()
    const upgrade = (url: string) => app().request(url, { headers: { cookie, upgrade: "websocket" } })

    expect((await upgrade("/doc/d1/connect")).status).toBe(200)
    expect((await upgrade("/session/abc/prompt-doc/submit/connect")).status).toBe(200)
    expect((await upgrade("/session/abc/question/submit/connect")).status).toBe(200)
    expect((await upgrade("/session/abc/question/draft/connect")).status).toBe(200)
    expect((await upgrade("/pty/p1/connect")).status).toBe(403)
    expect((await upgrade("/session/abc/env-request/draft/connect")).status).toBe(403)
    expect((await upgrade("/mcp/github/connect")).status).toBe(403)
  })

  test("allowed 는 GET/HEAD 만 조회로 본다", () => {
    expect(Viewer.allowed("GET", "/session", false)).toBe(true)
    expect(Viewer.allowed("HEAD", "/session", false)).toBe(true)
    expect(Viewer.allowed("PUT", "/session", false)).toBe(false)
    expect(Viewer.allowed("GET", "/tui/next", false)).toBe(false)
  })

  // JUPYTERHUB_* 는 모듈 로드 시점 상수라 hub 모드는 서브프로세스에서 검증한다.
  test("hub 모드: 관전 세션은 Hub OAuth 를 건너뛰고 서비스 경로에 쿠키를 둔다", async () => {
    const script = `
      process.env.JUPYTERHUB_API_URL = "http://hub.invalid/api"
      process.env.JUPYTERHUB_API_TOKEN = "test-token"
      process.env.JUPYTERHUB_USER = "team"
      process.env.JUPYTERHUB_SERVICE_PREFIX = "/user/team/"
      process.env.ENK_HACKATHON_RAILS_URL = "http://localhost:${rails.port}"
      process.env.ENK_AI_USAGE_TOKEN = "team-token"
      const { Hono } = await import("hono")
      const { HubAuth } = await import("./src/server/hub-auth.ts")
      const { Viewer } = await import("./src/server/viewer.ts")
      const app = new Hono().use(Viewer.auth()).use(HubAuth.auth()).all("/*", (c) => c.json({ ok: true }))

      const anon = await app.request("/session")
      if (anon.status !== 302) throw new Error("anon expected 302, got " + anon.status)

      const entered = await app.request("/session?viewer_ticket=good")
      const setCookie = entered.headers.get("set-cookie") ?? ""
      if (!setCookie.includes("Path=/user/team")) throw new Error("cookie path " + setCookie)
      const location = entered.headers.get("location") ?? ""
      if (!location.startsWith("/user/team/session?")) throw new Error("location " + location)
      const cookie = setCookie.split(";")[0]

      const read = await app.request("/session", { headers: { cookie } })
      if (read.status !== 200) throw new Error("viewer read expected 200, got " + read.status)
      const write = await app.request("/session", { method: "POST", headers: { cookie } })
      if (write.status !== 403) throw new Error("viewer write expected 403, got " + write.status)
      console.log("OK")
    `
    const proc = Bun.spawn(["bun", "-e", script], { cwd: pkgRoot, env: { ...process.env }, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
    expect(stderr.includes("Error")).toBe(false)
    expect(stdout).toContain("OK")
  }, 30_000)
})
