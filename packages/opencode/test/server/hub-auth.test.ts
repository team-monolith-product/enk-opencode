import { describe, expect, test } from "bun:test"
import path from "node:path"
import { HubAuth } from "../../src/server/hub-auth"
import { Hono } from "hono"

const pkgRoot = path.resolve(import.meta.dir, "../..")

describe("HubAuth internal token", () => {
  test("인증이 꺼진 환경에서는 그대로 통과한다", async () => {
    // 테스트/CI 환경엔 JUPYTERHUB_* / OPENCODE_SERVER_PASSWORD 가 없어 pass-through 여야 한다.
    const app = new Hono().use(HubAuth.auth()).get("/provider", (c) => c.json({ ok: true }))
    const res = await app.request("/provider")
    expect(res.status).toBe(200)
  })

  test("토큰은 프로세스 단위로 존재하고 헤더 이름이 안정적이다", () => {
    expect(HubAuth.INTERNAL_HEADER).toBe("x-opencode-internal-auth")
    expect(HubAuth.INTERNAL_TOKEN.length).toBeGreaterThan(10)
  })

  // JUPYTERHUB_* 플래그는 모듈 로드 시점 상수라, hub 모드는 env 를 먼저 심은
  // 서브프로세스에서 검증한다 (플러그인 in-process client 가 pod 에서 겪는 상황 재현).
  test("hub OAuth 모드: 익명은 리다이렉트, 내부 토큰은 통과", () => {
    const script = `
      process.env.JUPYTERHUB_API_URL = "http://hub.invalid/api"
      process.env.JUPYTERHUB_API_TOKEN = "test-token"
      process.env.JUPYTERHUB_USER = "student"
      const { Hono } = await import("hono")
      const { HubAuth } = await import("./src/server/hub-auth.ts")
      const app = new Hono().use(HubAuth.auth()).get("/provider", (c) => c.json({ ok: true }))

      const anon = await app.request("/provider")
      if (anon.status !== 302) throw new Error("anon expected 302, got " + anon.status)

      const internal = await app.request("/provider", {
        headers: { [HubAuth.INTERNAL_HEADER]: HubAuth.INTERNAL_TOKEN },
      })
      if (internal.status !== 200) throw new Error("internal expected 200, got " + internal.status)

      const wrong = await app.request("/provider", { headers: { [HubAuth.INTERNAL_HEADER]: "wrong" } })
      if (wrong.status !== 302) throw new Error("wrong token expected 302, got " + wrong.status)
      console.log("OK")
    `
    const result = Bun.spawnSync(["bun", "-e", script], {
      cwd: pkgRoot,
      env: { ...process.env },
    })
    const stdout = result.stdout.toString()
    const stderr = result.stderr.toString()
    expect(stderr.includes("Error")).toBe(false)
    expect(stdout).toContain("OK")
  })

  test("hub OAuth 모드: 허브 API 토큰은 소유자 일치 시 통과, 불일치 시 403", () => {
    const script = `
      process.env.JUPYTERHUB_API_URL = "http://hub.invalid/api"
      process.env.JUPYTERHUB_API_TOKEN = "test-token"
      process.env.JUPYTERHUB_USER = "student"
      const { Hono } = await import("hono")
      const { HubAuth } = await import("./src/server/hub-auth.ts")
      globalThis.fetch = async (url, init) => {
        const auth = new Headers(init?.headers).get("authorization") ?? ""
        if (auth === "token owner-token") return Response.json({ name: "student" })
        if (auth === "token other-token") return Response.json({ name: "intruder" })
        return new Response("forbidden", { status: 403 })
      }
      const app = new Hono().use(HubAuth.auth()).get("/provider", (c) => c.json({ ok: true }))

      const owner = await app.request("/provider", { headers: { authorization: "token owner-token" } })
      if (owner.status !== 200) throw new Error("owner expected 200, got " + owner.status)

      const other = await app.request("/provider", { headers: { authorization: "token other-token" } })
      if (other.status !== 403) throw new Error("other expected 403, got " + other.status)

      const invalid = await app.request("/provider", { headers: { authorization: "token bad-token" } })
      if (invalid.status !== 403) throw new Error("invalid expected 403, got " + invalid.status)
      console.log("OK")
    `
    const result = Bun.spawnSync(["bun", "-e", script], {
      cwd: pkgRoot,
      env: { ...process.env },
    })
    const stdout = result.stdout.toString()
    const stderr = result.stderr.toString()
    expect(stderr.includes("Error")).toBe(false)
    expect(stdout).toContain("OK")
  })
})
