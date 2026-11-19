import type { Context, MiddlewareHandler } from "hono"
import { createHmac, timingSafeEqual } from "node:crypto"
import { getCookie, setCookie } from "hono/cookie"
import z from "zod"
import { Rails } from "../enk/rails"
import { Flag } from "../flag/flag"
import { Log } from "../util/log"
import { HubActivity } from "./hub-activity"

export namespace Viewer {
  const log = Log.create({ service: "viewer" })

  export const QUERY = "viewer_ticket"
  const COOKIE = "opencode-viewer-session"
  const VERIFY_ROUTE = "/api/v1/opencode/viewer_ticket/verify"
  export const MAX_AGE_MS = 8 * 60 * 60 * 1000
  const TIMEOUT_MS = 10_000

  export const Info = z.object({ id: z.string(), name: z.string() })
  export type Info = z.infer<typeof Info>

  const Payload = Info.extend({ exp: z.number() })

  const marked = new WeakSet<Request>()

  const SOCKETS = [
    /^\/doc\/[^/]+\/connect$/,
    /^\/session\/[^/]+\/prompt-doc\/submit\/connect$/,
    /^\/session\/[^/]+\/question\/submit\/connect$/,
    /^\/session\/[^/]+\/question\/draft\/connect$/,
  ]

  const HIDDEN = [/^\/pty(\/|$)/, /^\/env-file\/[^/]+\/value$/, /^\/provider\/auth$/, /^\/auth(\/|$)/, /^\/tui(\/|$)/]

  const SECRET_FIELDS = new Set(["apiKey", "key", "token", "secret", "password", "authorization"])
  const SECRET_MAPS = new Set(["headers", "environment"])

  export function is(req: Request): boolean {
    return marked.has(req)
  }

  export function allowed(method: string, path: string, upgrade: boolean): boolean {
    if (upgrade) return SOCKETS.some((rule) => rule.test(path))
    if (method !== "GET" && method !== "HEAD") return false
    return !HIDDEN.some((rule) => rule.test(path))
  }

  export function redact<T>(req: Request, value: T): T {
    return is(req) ? (scrub(value) as T) : value
  }

  function scrub(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(scrub)
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        if (SECRET_FIELDS.has(key)) return []
        return [[key, SECRET_MAPS.has(key) ? {} : scrub(item)]]
      }),
    )
  }

  function prefix(): string {
    return Flag.JUPYTERHUB_SERVICE_PREFIX?.replace(/\/+$/, "") ?? ""
  }

  function relative(path: string): string {
    const base = prefix()
    if (base && (path === base || path.startsWith(base + "/"))) return path.slice(base.length) || "/"
    return path
  }

  function secret(): string | undefined {
    return process.env["ENK_AI_USAGE_TOKEN"] || undefined
  }

  function sign(body: string, key: string): string {
    return createHmac("sha256", key).update(body).digest("base64url")
  }

  export function seal(info: Info, now = Date.now()): string | undefined {
    const key = secret()
    if (!key) return
    const body = Buffer.from(JSON.stringify({ ...info, exp: now + MAX_AGE_MS })).toString("base64url")
    return `${body}.${sign(body, key)}`
  }

  export function open(value: string | undefined, now = Date.now()): Info | undefined {
    const key = secret()
    if (!key || !value) return
    const [body, mac] = value.split(".")
    if (!body || !mac) return
    const expected = Buffer.from(sign(body, key))
    const actual = Buffer.from(mac)
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return
    try {
      const parsed = Payload.safeParse(JSON.parse(Buffer.from(body, "base64url").toString()))
      if (!parsed.success || parsed.data.exp <= now) return
      return { id: parsed.data.id, name: parsed.data.name }
    } catch {
      return
    }
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

  async function enter(c: Context, ticket: string): Promise<Response> {
    const info = await verify(ticket)
    const value = info && seal(info)
    if (!info || !value) return c.text("Forbidden", 403)

    setCookie(c, COOKIE, value, {
      path: prefix() || "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: c.req.url.startsWith("https"),
      maxAge: MAX_AGE_MS / 1000,
    })
    log.info("viewer entered", { viewer: info.id })

    const url = new URL(c.req.url)
    url.searchParams.delete(QUERY)
    url.searchParams.set("readonly", "true")
    const path = "/" + relative(c.req.path).replace(/^\/+/, "")
    return c.redirect(`${prefix()}${path}${url.search}`)
  }

  export function auth(): MiddlewareHandler {
    return async (c, next) => {
      if (c.req.method === "OPTIONS") return next()

      const ticket = c.req.query(QUERY)
      if (ticket !== undefined) return enter(c, ticket)

      if (!open(getCookie(c, COOKIE))) return next()

      marked.add(c.req.raw)
      HubActivity.untrack(c.req.raw)
      if (!allowed(c.req.method, relative(c.req.path), !!c.req.header("upgrade"))) {
        return c.json({ error: "readonly viewer" }, 403)
      }
      return next()
    }
  }
}
