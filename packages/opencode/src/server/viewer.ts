import type { Context, MiddlewareHandler } from "hono"
import { getCookie, setCookie } from "hono/cookie"
import z from "zod"
import { Rails } from "../enk/rails"
import { Flag } from "../flag/flag"
import { Log } from "../util/log"
import { HubActivity } from "./hub-activity"

/**
 * 운영자 관전(읽기 전용) 세션.
 *
 * 운영자는 팀 허브 사용자가 아니라 Hub OAuth 를 통과할 수 없다. 대신 hackathon-rails 가 발급한
 * 짧은 수명의 `?viewer_ticket=` 을 이 pod 의 팀 토큰으로 rails 에 검증받아 관전 세션을 만든다.
 * 관전 세션의 요청은 클라이언트의 `?readonly=true` 와 무관하게 서버가 읽기만 허용한다.
 */
export namespace Viewer {
  const log = Log.create({ service: "viewer" })

  export const QUERY = "viewer_ticket"
  const COOKIE = "opencode-viewer-session"
  const VERIFY_ROUTE = "/api/v1/opencode/viewer_ticket/verify"
  const IDLE_MS = 60 * 60 * 1000
  const MAX_MS = 8 * 60 * 60 * 1000
  const TIMEOUT_MS = 10_000

  export const Info = z.object({ id: z.string(), name: z.string() })
  export type Info = z.infer<typeof Info>

  type Session = Info & { createdAt: number; seenAt: number }

  const sessions = new Map<string, Session>()
  const marked = new WeakSet<Request>()

  const SOCKETS = [
    /^\/doc\/[^/]+\/connect$/,
    /^\/session\/[^/]+\/prompt-doc\/submit\/connect$/,
    /^\/session\/[^/]+\/question\/submit\/connect$/,
    /^\/session\/[^/]+\/question\/draft\/connect$/,
  ]

  const HIDDEN = [
    /^\/pty(\/|$)/,
    /^\/env-file\/[^/]+\/value$/,
    /^\/provider\/auth$/,
    /^\/auth(\/|$)/,
    /^\/tui(\/|$)/,
  ]

  export function is(req: Request): boolean {
    return marked.has(req)
  }

  export function allowed(method: string, path: string, upgrade: boolean): boolean {
    if (upgrade) return SOCKETS.some((rule) => rule.test(path))
    if (method !== "GET" && method !== "HEAD") return false
    return !HIDDEN.some((rule) => rule.test(path))
  }

  function prefix(): string {
    return Flag.JUPYTERHUB_SERVICE_PREFIX?.replace(/\/+$/, "") ?? ""
  }

  function relative(path: string): string {
    const base = prefix()
    if (base && (path === base || path.startsWith(base + "/"))) return path.slice(base.length) || "/"
    return path
  }

  export async function verify(ticket: string): Promise<Info | undefined> {
    const endpoint = Rails.endpoint(VERIFY_ROUTE)
    if (!endpoint || !ticket) return
    try {
      const res = await fetch(endpoint.url, {
        method: "POST",
        headers: { ...endpoint.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ ticket }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) {
        log.warn("ticket rejected", { status: res.status })
        return
      }
      const parsed = z.object({ viewer: Info }).safeParse(await res.json())
      return parsed.success ? parsed.data.viewer : undefined
    } catch (error) {
      log.error("ticket verify error", { error })
      return
    }
  }

  function current(c: Context): Session | undefined {
    const sid = getCookie(c, COOKIE)
    if (!sid) return
    const session = sessions.get(sid)
    if (!session) return
    const now = Date.now()
    if (now - session.seenAt > IDLE_MS || now - session.createdAt > MAX_MS) {
      sessions.delete(sid)
      return
    }
    session.seenAt = now
    return session
  }

  function prune() {
    const now = Date.now()
    for (const [sid, session] of sessions) {
      if (now - session.seenAt > IDLE_MS || now - session.createdAt > MAX_MS) sessions.delete(sid)
    }
  }

  async function enter(c: Context, ticket: string): Promise<Response> {
    const info = await verify(ticket)
    if (!info) return c.text("Forbidden", 403)

    prune()
    const sid = crypto.randomUUID()
    const now = Date.now()
    sessions.set(sid, { ...info, createdAt: now, seenAt: now })
    setCookie(c, COOKIE, sid, {
      path: prefix() || "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: c.req.url.startsWith("https"),
      maxAge: MAX_MS / 1000,
    })
    log.info("viewer entered", { viewer: info.id })

    const url = new URL(c.req.url)
    url.searchParams.delete(QUERY)
    url.searchParams.set("readonly", "true")
    return c.redirect(`${prefix()}${relative(c.req.path)}${url.search}`)
  }

  export function auth(): MiddlewareHandler {
    return async (c, next) => {
      if (c.req.method === "OPTIONS") return next()

      const ticket = c.req.query(QUERY)
      if (ticket !== undefined) return enter(c, ticket)

      if (!current(c)) return next()

      marked.add(c.req.raw)
      HubActivity.untrack(c.req.raw)
      if (!allowed(c.req.method, relative(c.req.path), !!c.req.header("upgrade"))) {
        return c.json({ error: "readonly viewer" }, 403)
      }
      return next()
    }
  }
}
