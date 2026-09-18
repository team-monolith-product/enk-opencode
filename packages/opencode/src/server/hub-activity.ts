import type { MiddlewareHandler } from "hono"
import { GlobalBus } from "@/bus/global"
import { Flag } from "../flag/flag"
import { Log } from "../util/log"
import { HubAuth } from "./hub-auth"

export namespace HubActivity {
  const log = Log.create({ service: "hub-activity" })

  const DEFAULT_INTERVAL = 300
  const RETRY_MAX_WAIT = 15
  const RETRY_TIMEOUT = 60

  export type Target = { url: string; token: string; server: string; interval: number }

  type Event = { directory?: string; payload?: { type?: string; properties?: any } }

  const untracked = new WeakSet<Request>()
  const busy = new Map<string, Set<string>>()
  let last = Date.now()
  let started = false

  export function target(): Target | undefined {
    if (!HubAuth.enabled() || !Flag.JUPYTERHUB_ACTIVITY_URL) return
    const interval = Flag.JUPYTERHUB_ACTIVITY_INTERVAL ?? DEFAULT_INTERVAL
    if (interval <= 0) return
    return {
      url: Flag.JUPYTERHUB_ACTIVITY_URL,
      token: Flag.JUPYTERHUB_API_TOKEN!,
      server: Flag.JUPYTERHUB_SERVER_NAME ?? "",
      interval,
    }
  }

  export function touch() {
    last = Date.now()
  }

  export function untrack(req: Request) {
    untracked.add(req)
  }

  export function track(): MiddlewareHandler {
    return async (c, next) => {
      await next()
      if (c.req.method === "OPTIONS") return
      if (c.req.header(HubAuth.INTERNAL_HEADER) === HubAuth.INTERNAL_TOKEN) return
      if (c.req.header("upgrade")) return
      if (untracked.has(c.req.raw)) return
      if (c.req.query("no_track_activity") !== undefined) return
      if (c.res.headers.get("content-type")?.startsWith("text/event-stream")) return
      touch()
    }
  }

  export function observe(event: Event) {
    const type = event.payload?.type
    const directory = event.directory ?? ""
    if (type === "session.status") {
      const { sessionID, status } = event.payload?.properties ?? {}
      if (!sessionID || !status) return
      const sessions = busy.get(directory) ?? new Set<string>()
      if (status.type === "idle") sessions.delete(sessionID)
      else sessions.add(sessionID)
      if (sessions.size > 0) busy.set(directory, sessions)
      else busy.delete(directory)
      touch()
      return
    }
    if (type === "server.instance.disposed") {
      busy.delete(directory)
      return
    }
    if (type === "global.disposed") {
      busy.clear()
      return
    }
    if (busy.has(directory)) touch()
  }

  function sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.())
  }

  async function notify(target: Target, timestamp: string) {
    try {
      const res = await fetch(target.url, {
        method: "POST",
        headers: {
          Authorization: `token ${target.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          servers: { [target.server]: { last_activity: timestamp } },
          last_activity: timestamp,
        }),
      })
      if (res.ok) return true
      log.error("error notifying hub of activity", { status: res.status })
    } catch (error) {
      log.error("error notifying hub of activity", { error })
    }
    return false
  }

  export async function report(target: Target, timeout = RETRY_TIMEOUT) {
    const timestamp = new Date(last).toISOString()
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

  export function start(target: Target) {
    if (started) return
    started = true
    GlobalBus.on("event", observe)
    log.info("updating hub with activity", { interval: target.interval })
    void (async () => {
      while (true) {
        await report(target).catch((error) => log.error("error notifying hub of activity", { error }))
        await sleep(target.interval * 1000 * (1 + 0.2 * (Math.random() - 0.5)))
      }
    })()
  }
}
