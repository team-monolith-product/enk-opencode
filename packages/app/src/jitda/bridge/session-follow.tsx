import { useLocation, useNavigate } from "@solidjs/router"
import { onCleanup, onMount } from "solid-js"
import { useJitda } from "@/jitda/context"
import { useServer } from "@/runtime/server/current"
import { ServerConnection } from "@/runtime/server/registry"
import { sessionHref } from "@/shell/routes/session"

// 대화 지우기는 지운 사람만의 일이 아니다. 같은 세션을 보던 모두가 서버가 만든 대체 세션으로 같이 옮겨 간다.
// 자리를 비운 사이 지워졌다면 그 이벤트를 못 받으므로, 스트림이 다시 붙을 때 지금 세션이 살아 있는지 되묻는다.
export function SessionFollow() {
  const jitda = useJitda()
  const server = useServer()
  const navigate = useNavigate()
  const location = useLocation()
  const api = server.ctx.sdk.api
  let moving = false

  const follow = (removed: string) => {
    if (moving || removed !== jitda.sessionID) return
    moving = true
    void jitda.rpc.session
      .main({}, jitda.options())
      .then((session: unknown) => {
        const id = String((session as { id: string }).id)
        if (id === removed) return
        navigate(`${sessionHref(ServerConnection.key(server.conn), id)}${location.search}${location.hash}`, {
          replace: true,
        })
      })
      .finally(() => {
        moving = false
      })
  }

  const offArchived = server.ctx.sdk.event.on("session.archived", (event) => follow(String(event.data.sessionID)))
  const offDeleted = server.ctx.sdk.event.on("session.deleted", (event) => follow(String(event.data.sessionID)))
  const check = () => {
    const id = jitda.sessionID
    void api.session
      .get({ sessionID: id })
      .then((info: unknown) => {
        const value = info as { data?: { time?: { archived?: unknown } }; time?: { archived?: unknown } }
        if ((value.data ?? value).time?.archived) follow(id)
      })
      .catch(() => follow(id))
  }
  const offConnected = server.ctx.sdk.event.on("server.connected", check)
  onMount(check)

  onCleanup(() => {
    offArchived()
    offDeleted()
    offConnected()
  })

  return null
}
