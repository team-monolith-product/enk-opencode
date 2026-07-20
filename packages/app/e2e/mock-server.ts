import type { Page, Route } from "@playwright/test"

/**
 * Playwright mock of the opencode backend so dock/session tests can run against the real client
 * data path (bootstrap → store → reconcile → dock) without a live server or an LLM to seed todos.
 *
 * Adapted from upstream sst/opencode e2e/utils/mock-server.ts (commit d13779b1d5) to our app's
 * actual bootstrap calls. Key facts this relies on:
 *  - The app fetches the backend at VITE_OPENCODE_SERVER_PORT (default 4096); the UI is served on
 *    the app port. We only intercept the backend port.
 *  - The realtime channel is SSE at GET /global/event, envelope `{ directory, payload: Event }`.
 *    Playwright can't hold a stream open, so each connection returns the currently-queued events
 *    and closes; the client reconnects (~250ms) and drains the next batch. Push via `emit()`.
 *  - Todos have no id — `{ content, status, priority }` only.
 *  - The SSE `directory`, the `?directory=` query, and the base64 URL slug must all be the same
 *    absolute directory string.
 */

type Json = unknown

export type MockSession = { id: string } & Record<string, Json>

export interface MockServerConfig {
  directory: string
  /** ProviderListResponse — { all, connected, default }. */
  provider?: Json
  project?: Json
  /** Current session list; may be a function so tests can grow it over time. */
  sessions: MockSession[] | (() => MockSession[])
  /** Per-session todo list returned by GET /session/:id/todo. */
  todos?: (sessionID: string) => Json[]
  /** sessionID → SessionStatus map returned by GET /session/status (drives live()). */
  status?: () => Record<string, Json>
  /** Messages page for GET /session/:id/message. Defaults to empty. */
  pageMessages?: (sessionID: string, limit: number, before?: string) => { items: Json[]; cursor?: string }
  permissions?: () => Json[]
  questions?: () => Json[]
}

const emptyList = new Set(["/skill", "/command", "/lsp", "/formatter", "/vcs/status", "/vcs/diff", "/mcp/list"])
const emptyObject = new Set(["/global/config", "/config", "/provider/auth", "/mcp"])

const defaultProvider = { all: [], connected: [], default: {} }

export async function mockOpenCodeServer(page: Page, config: MockServerConfig) {
  const cursors = new Map<string, string>()
  let nextCursor = 0

  // SSE event queue. emit() enqueues one `{ directory, payload }`; the next /global/event connection
  // drains everything currently queued and closes, so the client reconnects and drains the rest.
  const queue: Json[] = []
  const emit = (payload: Json, directory = config.directory) => {
    queue.push({ directory, payload })
  }

  const sessions = () => (typeof config.sessions === "function" ? config.sessions() : config.sessions)

  const staticRoutes = (): Record<string, Json> => ({
    "/provider": config.provider ?? defaultProvider,
    "/path": {
      state: config.directory,
      config: config.directory,
      worktree: config.directory,
      directory: config.directory,
      home: config.directory,
    },
    "/env": {},
    "/project": [config.project],
    "/project/current": config.project,
    "/agent": [{ name: "build", mode: "primary" }],
    "/vcs": { branch: "main", default_branch: "main" },
    "/session/status": config.status?.() ?? {},
    "/session": sessions(),
  })

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    const targetPort = process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"
    const appPort = new URL(
      process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "3000"}`,
    ).port
    if (url.port !== targetPort && url.port !== appPort) return route.fallback()

    const path = url.pathname

    if (path === "/global/event" || path === "/event") {
      const drained = queue.splice(0, queue.length)
      return sse(route, drained)
    }
    if (path === "/global/health") return json(route, { healthy: true })
    if (path === "/permission") return json(route, config.permissions?.() ?? [])
    if (path === "/question") return json(route, config.questions?.() ?? [])
    if (emptyObject.has(path)) return json(route, {})
    if (emptyList.has(path)) return json(route, [])

    const routes = staticRoutes()
    if (path in routes) return json(route, routes[path])

    const todoMatch = path.match(/^\/session\/([^/]+)\/todo$/)
    if (todoMatch) return json(route, config.todos?.(todoMatch[1]!) ?? [])

    if (/^\/session\/[^/]+\/(children|diff)$/.test(path)) return json(route, [])

    const messagesMatch = path.match(/^\/session\/([^/]+)\/message$/)
    if (messagesMatch) {
      const token = url.searchParams.get("before") ?? undefined
      const before = token ? cursors.get(token) : undefined
      if (token && !before) return json(route, { error: "Invalid cursor" }, undefined, 400)
      const limit = Number(url.searchParams.get("limit") ?? 80)
      const pageData = config.pageMessages?.(messagesMatch[1]!, limit, before) ?? { items: [] }
      if (!pageData.cursor) return json(route, pageData.items)
      const cursor = `cursor_${++nextCursor}`
      cursors.set(cursor, pageData.cursor)
      return json(route, pageData.items, { "x-next-cursor": cursor })
    }

    const sessionMatch = path.match(/^\/session\/([^/]+)$/)
    if (sessionMatch) {
      const session = sessions().find((s) => s.id === sessionMatch[1])
      return json(route, session ?? {})
    }

    // Unknown backend endpoint: stub with {} so bootstrap keeps going (matches upstream behaviour).
    if (url.port === targetPort && targetPort !== appPort) return json(route, {})
    return route.fallback()
  })

  return {
    emit,
    /** Number of events still queued (not yet drained by an SSE connection). */
    pending: () => queue.length,
  }
}

function json(route: Route, body: Json, headers?: Record<string, string>, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "x-next-cursor",
      ...headers,
    },
    body: JSON.stringify(body ?? null),
  })
}

function sse(route: Route, events: Json[]) {
  const body = events.length
    ? events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
    : ": ok\n\n"
  return route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    headers: { "access-control-allow-origin": "*" },
    body,
  })
}

/** todo.updated event envelope payload. */
export function todoEvent(sessionID: string, todos: Json[]) {
  return { type: "todo.updated", properties: { sessionID, todos } }
}

/** session.status event envelope payload. */
export function statusEvent(sessionID: string, status: Json) {
  return { type: "session.status", properties: { sessionID, status } }
}

/** session.created event envelope payload. */
export function sessionCreatedEvent(info: MockSession) {
  return { type: "session.created", properties: { info } }
}
