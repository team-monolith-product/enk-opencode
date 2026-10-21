import { PostMessageManagerImpl } from "@team-monolith/post-message-manager"
import { onCleanup, onMount } from "solid-js"

type State = "delivered" | "already_delivered" | "not_finalized" | "pending_elsewhere" | "failed"

export type Result = { status: "ok"; payload: { state: State } } | { status: "failed"; error: string }

const MESSAGE = "initial.plan.submit"
const STATES: State[] = ["delivered", "already_delivered", "not_finalized", "pending_elsewhere", "failed"]

export function bridgeResult(status: number, body: unknown): Result {
  const value = (body ?? {}) as { state?: unknown; error?: unknown }
  const state = STATES.find((item) => item === value.state)
  if (status >= 200 && status < 300 && state) return { status: "ok", payload: { state } }
  return { status: "failed", error: typeof value.error === "string" ? value.error : `HTTP ${status}` }
}
const TIMEOUT_MS = 30_000

export function InitialPlanBridge() {
  onMount(() => {
    const pmm = new PostMessageManagerImpl(TIMEOUT_MS)
    pmm.register({
      messageType: MESSAGE,
      callback: async (): Promise<Result> => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
        try {
          const res = await fetch(new URL("enk/initial-plan/deliver", document.baseURI), {
            method: "POST",
            signal: controller.signal,
          })
          return bridgeResult(res.status, await res.json().catch(() => undefined))
        } catch (e) {
          if (controller.signal.aborted) return { status: "failed", error: "timeout" }
          return { status: "failed", error: e instanceof Error ? e.message : String(e) }
        } finally {
          clearTimeout(timer)
        }
      },
    })
    onCleanup(() => pmm.unregister(MESSAGE))
  })
  return null
}
