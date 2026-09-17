import type { MiddlewareHandler } from "hono"
import { GlobalBus } from "@/bus/global"
import { Flag } from "../flag/flag"
import { Log } from "../util/log"
import { HubAuth } from "./hub-auth"

export namespace HubActivity {
  const log = Log.create({ service: "hub-activity" })

  const INTERVAL = 300_000
  const PASSIVE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

  type Event = { directory?: string; payload?: { type?: string; properties?: any } }

  const busy = new Map<string, Set<string>>()
  let last: Date | undefined
  let sent: Date | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  export function enabled() {
    return HubAuth.enabled() && !!Flag.JUPYTERHUB_ACTIVITY_URL
  }

  export function touch(at = new Date()) {
    if (!last || at > last) last = at
  }

  export function track(): MiddlewareHandler {
    return async (c, next) => {
      await next()
      if (PASSIVE_METHODS.has(c.req.method) || c.req.path === "/log") return
      if (c.req.header(HubAuth.INTERNAL_HEADER) === HubAuth.INTERNAL_TOKEN) return
      if (c.res.status >= 400) return
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
    if (type === "server.instance.disposed") busy.delete(directory)
    if (type === "global.disposed") busy.clear()
  }

  export async function report(now = new Date()) {
    if (busy.size > 0) touch(now)
    if (!last || (sent && last <= sent)) return
    const at = last
    const timestamp = at.toISOString()
    try {
      const res = await fetch(Flag.JUPYTERHUB_ACTIVITY_URL!, {
        method: "POST",
        headers: {
          Authorization: `token ${Flag.JUPYTERHUB_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          servers: { [Flag.JUPYTERHUB_SERVER_NAME ?? ""]: { last_activity: timestamp } },
          last_activity: timestamp,
        }),
      })
      if (!res.ok) {
        log.warn("activity report rejected", { status: res.status })
        return
      }
      sent = at
    } catch (error) {
      log.warn("activity report failed", { error })
    }
  }

  export function start() {
    if (timer || !enabled()) return
    GlobalBus.on("event", observe)
    const schedule = () => {
      timer = setTimeout(() => void report().finally(schedule), INTERVAL * (0.9 + Math.random() * 0.2))
      timer.unref?.()
    }
    schedule()
  }
}
