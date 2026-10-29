import { PostMessageManagerImpl } from "@team-monolith/post-message-manager"
import { onCleanup, onMount } from "solid-js"
import { useJitda } from "@/jitda/context"

type Summary = { title: string; description: string; usage: string }

type Result = { status: "ok"; payload: Summary } | { status: "failed"; error: string }

const TIMEOUT_MS = 60_000

// 짓다 프론트(부모 창)가 갤러리 등록 때 보내는 project.summary.request 에 지금 세션의 요약으로 답한다.
export function ProjectSummaryBridge() {
  const jitda = useJitda()

  onMount(() => {
    const pmm = new PostMessageManagerImpl(TIMEOUT_MS)
    pmm.register({
      messageType: "project.summary.request",
      callback: async (): Promise<Result> => {
        const sessionID = jitda.sessionID
        if (!sessionID) return { status: "failed", error: "no session" }
        const timeout = new Promise<Result>((resolve) =>
          setTimeout(() => resolve({ status: "failed", error: "timeout" }), TIMEOUT_MS),
        )
        const request = jitda.rpc.projectSummary
          .generate({ sessionID }, jitda.options())
          .then((payload: unknown): Result => ({ status: "ok", payload: payload as Summary }))
          .catch((error: unknown): Result => ({
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          }))
        return Promise.race([request, timeout])
      },
    })
    onCleanup(() => pmm.unregister("project.summary.request"))
  })

  return null
}
