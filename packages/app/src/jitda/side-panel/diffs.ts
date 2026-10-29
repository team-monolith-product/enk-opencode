import type { FileDiffInfo } from "@opencode/client/promise"
import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { useData, useServer } from "@/runtime/server/current"
import { selectSessionUserMessages } from "@/session/session-domain"
import { useWorkspaceLocation } from "@/workspaces/location"

// V1 session_diff(세션 전체 변경) 자리. V2 session.diff 는 기본이 마지막 턴이라 첫 사용자 메시지부터 마지막까지로 묻는다.
export function createSessionDiffs(sessionID: () => string) {
  const server = useServer()
  const data = useData()
  const location = useWorkspaceLocation()
  const [diffs, setDiffs] = createSignal<readonly FileDiffInfo[]>([])
  const [loaded, setLoaded] = createSignal(false)

  const range = createMemo(() => {
    const users = selectSessionUserMessages(data.session.message.list(sessionID()))
    const first = users[0]?.id
    const last = users.at(-1)?.id
    return first ? `${first}\n${last ?? first}` : ""
  })

  let token = 0
  const refresh = () => {
    const id = sessionID()
    const [from, to] = range().split("\n")
    const current = ++token
    if (!from) {
      setDiffs([])
      setLoaded(true)
      return
    }
    void server.ctx.sdk.api.session
      .diff({ sessionID: id, from, ...(to && to !== from ? { to } : {}) })
      .then((result) => {
        if (current !== token) return
        setDiffs(result)
        setLoaded(true)
      })
      .catch(() => {
        if (current !== token) return
        setLoaded(true)
      })
  }

  createEffect(on(range, refresh))

  createEffect(() => {
    const stop = location().event.on("session.idle", (event) => {
      if (event.data.sessionID !== sessionID()) return
      refresh()
    })
    onCleanup(stop)
  })

  return { diffs, loaded }
}
