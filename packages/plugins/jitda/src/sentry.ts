import * as SentryBun from "@sentry/bun"

// V1 SentryReporter 와 같다. JupyterHub 파드(JUPYTERHUB_API_URL 주입)에서만 켜고 OPENCODE_SENTRY_DISABLED 로 끈다.
const DSN = "https://e22b8291293e6d85e775ae7313a804d3@o1200796.ingest.us.sentry.io/4511380949565440"
const LIMIT = 200

let enabled = false

export function init(env: NodeJS.ProcessEnv = process.env) {
  if (enabled) return
  if (!env.JUPYTERHUB_API_URL) return
  const disabled = env.OPENCODE_SENTRY_DISABLED?.toLowerCase()
  if (disabled === "1" || disabled === "true") return
  // CLI 가 먼저 켰으면 같은 프로세스의 클라이언트를 같이 쓴다. 두 번 켜면 프로세스 핸들러가 겹친다.
  if (SentryBun.getClient()) {
    enabled = true
    return
  }

  SentryBun.init({
    dsn: DSN,
    environment: env.ENVIRONMENT,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    initialScope: {
      user: env.JUPYTERHUB_USER ? { username: env.JUPYTERHUB_USER } : undefined,
      tags: {
        ...(env.OPENCODE_SERVE_DOMAIN ? { serveDomain: env.OPENCODE_SERVE_DOMAIN } : {}),
      },
    },
  })
  enabled = true
}

export type Scope = { tags?: Record<string, string>; fingerprint?: string[] }

export function captureException(error: unknown, context?: Record<string, unknown>, scope?: Scope) {
  if (!enabled) return
  SentryBun.captureException(error, context || scope ? { extra: context, ...scope } : undefined)
}

export async function flush(timeout = 2000) {
  if (!enabled) return
  await SentryBun.flush(timeout).catch(() => undefined)
}

const seen = new Map<string, number>()

export function due(key: string, ttl = 10 * 60_000, now = Date.now()) {
  const until = seen.get(key)
  if (until !== undefined && now < until) return false
  seen.set(key, now + ttl)
  if (seen.size > LIMIT) seen.forEach((expiry, name) => expiry <= now && seen.delete(name))
  return true
}

export function tracked() {
  return seen.size
}

export function captureOnce(key: string, error: unknown, context?: Record<string, unknown>, scope?: Scope) {
  if (!enabled || !due(key)) return
  captureException(error, context, scope)
}

export function isEnabled() {
  return enabled
}

export * as Sentry from "./sentry"
