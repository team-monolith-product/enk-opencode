import type { MiddlewareHandler } from "hono"
import { GlobalBus } from "@/bus/global"
import { Flag } from "../flag/flag"
import { Log } from "../util/log"
import { HubAuth } from "./hub-auth"

export namespace HubActivity {
  const log = Log.create({ service: "hub-activity" })

  const DEFAULT_INTERVAL = 300

  type Event = { directory?: string; payload?: { type?: string; properties?: any } }

  const untracked = new WeakSet<Request>()
  const busy = new Map<string, Set<string>>()
  let last = new Date()
  let started = false

  function interval() {
    return Flag.JUPYTERHUB_ACTIVITY_INTERVAL ?? DEFAULT_INTERVAL
  }

  export function enabled() {
    return HubAuth.enabled() && !!Flag.JUPYTERHUB_ACTIVITY_URL && interval() > 0
  }

  export function touch(at = new Date()) {
    if (at > last) last = at
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

  async function notify(timestamp: string) {
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
      if (res.ok) return true
      log.error("error notifying hub of activity", { status: res.status })
    } catch (error) {
      log.error("error notifying hub of activity", { error })
    }
    return false
  }

  async function backoff(pass: () => Promise<boolean>, input: { startWait: number; maxWait: number; timeout: number }) {
    const tolerance = 0.1 * input.timeout
    const deadline = performance.now() + (input.timeout + (Math.random() * 2 - 1) * tolerance) * 1000
    let scale = 1
    while (true) {
      if (await pass()) return
      const remaining = deadline - performance.now()
      if (remaining < 0) break
      const limit = Math.min(input.maxWait, input.startWait * scale)
      if (limit < input.maxWait) scale *= 2
      await sleep(Math.min(remaining, Math.random() * limit * 1000))
    }
    throw new Error("Failed to notify Hub of activity")
  }

  export async function report(timeout = 60) {
    const timestamp = last.toISOString()
    await backoff(() => notify(timestamp), { startWait: 1, maxWait: 15, timeout })
  }

  export function start() {
    if (started || !enabled()) return
    started = true
    GlobalBus.on("event", observe)
    log.info("updating hub with activity", { interval: interval() })
    void (async () => {
      while (true) {
        await report().catch((error) => log.error("error notifying hub of activity", { error }))
        await sleep(interval() * 1000 * (1 + 0.2 * (Math.random() - 0.5)))
      }
    })()
  }
}
