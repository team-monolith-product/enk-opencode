import type { ServerProcess } from "@opencode/server/process"
import { Effect } from "effect"
import { Headers, HttpServerRequest, HttpServerResponse } from "effect/http"
import { randomUUID } from "node:crypto"

// JupyterHub singleuser 로 뜰 때의 경로 prefix, Hub OAuth, activity 보고, CSP.
// 브라우저 -> CHP(/user/<name>/) -> pod:8888 이고 CHP 는 인증 없이 라우팅만 하므로 여기서 사용자를 검증한다.
// OAuth 흐름은 jupyterhub 5.4.3 services/auth.py 의 HubOAuth/HubAuthenticated 를 따른다.
// https://github.com/jupyterhub/jupyterhub/blob/652390e/jupyterhub/services/auth.py#L874-L1618

const COOKIE = "opencode-hub-session"
const STATE_COOKIE = "opencode-hub-state"
const CALLBACK = "/oauth_callback"
const CACHE_TTL = 5 * 60 * 1000
const COOKIE_MAX_AGE = "24 hours"
const STATE_MAX_AGE = "5 minutes"
const DEFAULT_ACTIVITY_INTERVAL = 300
const RETRY_MAX_WAIT = 15
const RETRY_TIMEOUT = 60
const SENTRY_INGEST = "https://o1200796.ingest.us.sentry.io"

type Session = { user: string; token: string; cachedAt: number }

const sessions = new Map<string, Session>()
const states = new Map<string, { csrf: string; next: string }>()
let lastActivity = Date.now()

const env = (name: string) => process.env[name] || undefined

export function prefix() {
  return env("JUPYTERHUB_SERVICE_PREFIX")?.replace(/\/+$/, "") ?? ""
}

export function enabled() {
  return !!(env("JUPYTERHUB_API_URL") && env("JUPYTERHUB_API_TOKEN") && env("JUPYTERHUB_USER"))
}

export function touch() {
  lastActivity = Date.now()
}

function api(path: string) {
  return `${env("JUPYTERHUB_API_URL")!.replace(/\/+$/, "")}${path}`
}

function callbackUrl(request: HttpServerRequest.HttpServerRequest) {
  const configured = env("JUPYTERHUB_OAUTH_CALLBACK_URL")
  if (configured) return configured
  const proto = request.headers["x-forwarded-proto"] ?? "http"
  const host = request.headers["x-forwarded-host"] ?? request.headers.host ?? "localhost"
  return `${proto}://${host}${prefix()}${CALLBACK}`
}

function authorizeUrl(callback: string, state: string) {
  const base = env("JUPYTERHUB_BASE_URL")?.replace(/\/+$/, "") ?? ""
  const params = new URLSearchParams({
    client_id: env("JUPYTERHUB_CLIENT_ID") ?? "",
    redirect_uri: callback,
    response_type: "code",
    state,
  })
  return `${base}/hub/api/oauth2/authorize?${params}`
}

async function exchange(code: string, callback: string) {
  const res = await fetch(api("/oauth2/token"), {
    method: "POST",
    headers: {
      Authorization: `token ${env("JUPYTERHUB_API_TOKEN")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: env("JUPYTERHUB_CLIENT_ID") ?? "",
      client_secret: env("JUPYTERHUB_API_TOKEN") ?? "",
      grant_type: "authorization_code",
      code,
      redirect_uri: callback,
    }),
  }).catch(() => undefined)
  if (!res?.ok) return undefined
  return ((await res.json()) as { access_token?: string }).access_token
}

async function userinfo(token: string) {
  const res = await fetch(api("/user"), { headers: { Authorization: `token ${token}` } }).catch(() => undefined)
  if (!res?.ok) return undefined
  return ((await res.json()) as { name?: string }).name
}

function secure(request: HttpServerRequest.HttpServerRequest) {
  return (request.headers["x-forwarded-proto"] ?? "") === "https"
}

const callback = Effect.fn("cli.jitda-hub.callback")(function* (request: HttpServerRequest.HttpServerRequest) {
  const url = new URL(request.url, "http://localhost")
  const code = url.searchParams.get("code")
  const stateID = url.searchParams.get("state")
  const csrf = request.cookies[STATE_COOKIE]
  const state = stateID ? states.get(stateID) : undefined
  if (!code || !stateID || !csrf || !state || state.csrf !== csrf)
    return HttpServerResponse.text("Bad request", { status: 400 })
  states.delete(stateID)
  const token = yield* Effect.promise(() => exchange(code, callbackUrl(request)))
  if (!token) return HttpServerResponse.text("Token exchange failed", { status: 502 })
  const name = yield* Effect.promise(() => userinfo(token))
  if (!name) return HttpServerResponse.text("Failed to identify user", { status: 502 })
  if (name !== env("JUPYTERHUB_USER")) return HttpServerResponse.text("Forbidden", { status: 403 })
  const sid = randomUUID()
  sessions.set(sid, { user: name, token, cachedAt: Date.now() })
  return HttpServerResponse.redirect(state.next.startsWith("/") ? state.next : "/").pipe(
    HttpServerResponse.setCookieUnsafe(STATE_COOKIE, "", { path: "/", maxAge: 0 }),
    HttpServerResponse.setCookieUnsafe(COOKIE, sid, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: secure(request),
      maxAge: COOKIE_MAX_AGE,
    }),
  )
})

const sessionValid = Effect.fn("cli.jitda-hub.session")(function* (request: HttpServerRequest.HttpServerRequest) {
  const sid = request.cookies[COOKIE]
  const session = sid ? sessions.get(sid) : undefined
  if (!sid || !session) return false
  if (Date.now() - session.cachedAt < CACHE_TTL) return true
  const name = yield* Effect.promise(() => userinfo(session.token))
  if (name === env("JUPYTERHUB_USER")) {
    sessions.set(sid, { ...session, cachedAt: Date.now() })
    return true
  }
  sessions.delete(sid)
  return false
})

function hasCredential(request: HttpServerRequest.HttpServerRequest) {
  if (/^Basic\s+/i.test(request.headers.authorization ?? "")) return true
  return new URL(request.url, "http://localhost").searchParams.has("auth_token")
}

function login(request: HttpServerRequest.HttpServerRequest, path: string) {
  if (request.headers.upgrade || (request.headers["sec-fetch-mode"] ?? "navigate") !== "navigate")
    return HttpServerResponse.jsonUnsafe(
      { _tag: "UnauthorizedError", message: "Authentication required" },
      { status: 401 },
    )
  const csrf = randomUUID()
  const stateID = randomUUID()
  states.set(stateID, { csrf, next: `${prefix()}${path}` })
  return HttpServerResponse.redirect(authorizeUrl(callbackUrl(request), stateID)).pipe(
    HttpServerResponse.setCookieUnsafe(STATE_COOKIE, csrf, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: secure(request),
      maxAge: STATE_MAX_AGE,
    }),
  )
}

function tracked(request: HttpServerRequest.HttpServerRequest, response: HttpServerResponse.HttpServerResponse) {
  if (request.method === "OPTIONS" || request.headers.upgrade) return false
  const url = new URL(request.url, "http://localhost")
  if (url.searchParams.has("no_track_activity")) return false
  if (!url.pathname.startsWith("/api/") || url.pathname === "/api/event") return false
  return !(response.headers["content-type"] ?? "").startsWith("text/event-stream")
}

export function wrap(inner: ServerProcess.Transform, password: string): ServerProcess.Transform {
  const basic = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  return (app) => {
    const served = inner(app)
    return Effect.gen(function* () {
      let request = yield* HttpServerRequest.HttpServerRequest
      const base = prefix()
      const url = new URL(request.url, "http://localhost")
      if (base && (url.pathname === base || url.pathname.startsWith(`${base}/`))) {
        url.pathname = url.pathname.slice(base.length) || "/"
        request = request.modify({ url: `${url.pathname}${url.search}` })
      }
      if (enabled() && request.method !== "OPTIONS") {
        if (url.pathname === CALLBACK) return yield* callback(request)
        if (!hasCredential(request)) {
          if (!(yield* sessionValid(request))) return login(request, `${url.pathname}${url.search}`)
          request = request.modify({ headers: Headers.set(request.headers, "authorization", basic) })
        }
      }
      const response = yield* served.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request))
      if (tracked(request, response)) touch()
      return response
    })
  }
}

export function html(body: string) {
  const base = prefix()
  if (!base) return body
  return body.replace(/(href|src)="\//g, `$1="`).replace("<head>", `<head>\n    <base href="${base}/" />`)
}

export function csp(hash = "") {
  const domain = env("OPENCODE_SERVE_DOMAIN")
  if (!domain) return undefined
  const user = env("JUPYTERHUB_USER")
  const origins = (...parts: Array<string | undefined>) => parts.filter(Boolean).join(" ")
  const preview = user ? `https://${user}.${domain}` : undefined
  const tutorial = user ? `https://${user}-tutorial.${domain}` : undefined
  const frame = origins("'self'", preview, tutorial, `https://user.${domain}`)
  const connect = origins("'self'", "data:", "blob:", `https://*.${domain}`, SENTRY_INGEST)
  const script = origins("'self'", "'wasm-unsafe-eval'", hash ? `'sha256-${hash}'` : undefined)
  return `frame-ancestors ${origins("'self'", domain)}; default-src 'self'; frame-src ${frame}; script-src ${script}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; media-src 'self' data: blob:; worker-src 'self' blob:; connect-src ${connect}`
}

type Activity = { url: string; token: string; server: string; interval: number }

function activityTarget(): Activity | undefined {
  const url = env("JUPYTERHUB_ACTIVITY_URL")
  if (!enabled() || !url) return undefined
  const interval = Number(env("JUPYTERHUB_ACTIVITY_INTERVAL") ?? DEFAULT_ACTIVITY_INTERVAL)
  if (!(interval > 0)) return undefined
  return { url, token: env("JUPYTERHUB_API_TOKEN")!, server: env("JUPYTERHUB_SERVER_NAME") ?? "", interval }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.())

async function notify(target: Activity, timestamp: string) {
  const res = await fetch(target.url, {
    method: "POST",
    headers: { Authorization: `token ${target.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ servers: { [target.server]: { last_activity: timestamp } }, last_activity: timestamp }),
  }).catch(() => undefined)
  return !!res?.ok
}

export async function report(target: Activity, timeout = RETRY_TIMEOUT) {
  const timestamp = new Date(lastActivity).toISOString()
  const deadline = performance.now() + (timeout + (Math.random() * 2 - 1) * 0.1 * timeout) * 1000
  let scale = 1
  while (!(await notify(target, timestamp))) {
    const remaining = deadline - performance.now()
    if (remaining < 0) throw new Error("Failed to notify Hub of activity")
    const limit = Math.min(RETRY_MAX_WAIT, scale)
    if (limit < RETRY_MAX_WAIT) scale *= 2
    await sleep(Math.min(remaining, Math.random() * limit * 1000))
  }
}

export function observe(busy: Set<string>, event: { type?: string; data?: any }) {
  if (event.type === "server.connected") {
    busy.clear()
    return
  }
  if (event.type === "session.status") {
    const { sessionID, status } = event.data ?? {}
    if (!sessionID || !status) return
    if (status.type === "idle") busy.delete(sessionID)
    else busy.add(sessionID)
    touch()
    return
  }
  if (busy.size > 0) touch()
}

async function watch(server: string, password: string, busy: Set<string>) {
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  while (true) {
    const res = await fetch(`${server}/api/event`, { headers: { authorization: auth } }).catch(() => undefined)
    if (res?.ok && res.body) {
      const decoder = new TextDecoder()
      let buffer = ""
      try {
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true })
          let end = buffer.indexOf("\n\n")
          while (end !== -1) {
            const data = buffer
              .slice(0, end)
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n")
            buffer = buffer.slice(end + 2)
            if (data) {
              try {
                observe(busy, JSON.parse(data))
              } catch {}
            }
            end = buffer.indexOf("\n\n")
          }
        }
      } catch {}
    }
    busy.clear()
    await sleep(1000)
  }
}

export function start(server: string, password: string) {
  const target = activityTarget()
  if (!target) return
  const busy = new Set<string>()
  void watch(server, password, busy)
  void (async () => {
    while (true) {
      await report(target).catch((error) => console.error("error notifying hub of activity", error))
      await sleep(target.interval * 1000 * (1 + 0.2 * (Math.random() - 0.5)))
    }
  })()
}

export * as JitdaHub from "./jitda-hub"
