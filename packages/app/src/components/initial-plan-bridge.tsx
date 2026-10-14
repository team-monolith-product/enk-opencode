import { PostMessageManagerImpl } from "@team-monolith/post-message-manager"
import { onCleanup, onMount } from "solid-js"

type State = "delivered" | "already_delivered" | "not_finalized"

type Result = { status: "ok"; payload: { state: State } } | { status: "failed"; error: string }

const MESSAGE = "initial.plan.submit"
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
          const body = (await res.json().catch(() => undefined)) as { state?: State; error?: string } | undefined
          if (!res.ok || !body?.state) return { status: "failed", error: body?.error ?? `HTTP ${res.status}` }
          return { status: "ok", payload: { state: body.state } }
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
