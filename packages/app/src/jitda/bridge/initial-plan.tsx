import { PostMessageManagerImpl } from "@team-monolith/post-message-manager"
import { onCleanup, onMount } from "solid-js"
import { useJitda } from "@/jitda/context"

type State = "delivered" | "already_delivered" | "not_finalized" | "pending_elsewhere" | "failed"

export type Result = { status: "ok"; payload: { state: State } } | { status: "failed"; error: string }

const MESSAGE = "initial.plan.submit"
const PATH = "/api/jitda/initial-plan/deliver"
const STATES: State[] = ["delivered", "already_delivered", "not_finalized", "pending_elsewhere", "failed"]
const TIMEOUT_MS = 30_000

export function bridgeResult(status: number, body: unknown): Result {
  const value = (body ?? {}) as { state?: unknown; error?: unknown }
  const state = STATES.find((item) => item === value.state)
  if (status >= 200 && status < 300 && state) return { status: "ok", payload: { state } }
  return { status: "failed", error: typeof value.error === "string" ? value.error : `HTTP ${status}` }
}

export async function deliver(request: (path: string, init?: RequestInit) => Promise<Response>): Promise<Result> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await request(PATH, { method: "POST", signal: controller.signal })
    return bridgeResult(res.status, await res.json().catch(() => undefined))
  } catch (e) {
    if (controller.signal.aborted) return { status: "failed", error: "timeout" }
    return { status: "failed", error: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
}

// 짓다 프론트(부모 창)가 최초 기획을 확정하면 보내는 initial.plan.submit 에, 서버가 메인 세션의 Plan 에 넘긴 결과로 답한다.
export function InitialPlanBridge() {
  const jitda = useJitda()

  onMount(() => {
    const pmm = new PostMessageManagerImpl(TIMEOUT_MS)
    pmm.register({ messageType: MESSAGE, callback: () => deliver(jitda.request) })
    onCleanup(() => pmm.unregister(MESSAGE))
  })

  return null
}
