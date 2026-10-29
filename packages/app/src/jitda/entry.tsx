import { Session } from "@opencode/plugin-jitda/rpc"
import { Navigate, useLocation, useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, Show } from "solid-js"
import { ServerProvider, useServer } from "@/runtime/server/current"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { decode64 } from "@/runtime/persistence/base64"
import { sessionHref } from "@/shell/routes/session"

// 짓다 프론트는 V1 주소 `/<base64url(작업 폴더)>/` 와 `/<..>/session/<id>` 로 iframe 을 연다.
// 폴더만 오면 그 폴더의 메인 세션을 찾아(없으면 만들어) V2 세션 주소로 옮긴다. ?user·?locale 같은 쿼리는 그대로 넘긴다.
export function JitdaEntry() {
  const params = useParams<{ dir: string; id?: string }>()
  const servers = useServers()
  const directory = createMemo(() => decode64(params.dir))
  const server = createMemo(() => servers.list.find((item) => item.type === "http"))

  return (
    <Show when={directory() && server()} fallback={<Navigate href="/" />}>
      <ServerProvider conn={server()!}>
        <Resolve directory={directory()!} sessionID={params.id} />
      </ServerProvider>
    </Show>
  )
}

function Resolve(props: { directory: string; sessionID?: string }) {
  const server = useServer()
  const navigate = useNavigate()
  const location = useLocation()

  createEffect(() => {
    const directory = props.directory
    const target = props.sessionID
      ? Promise.resolve(props.sessionID)
      : server.ctx.sdk.api
          .rpc(Session)
          .main({}, { location: { directory } })
          .then((session: unknown) => String((session as { id: string }).id))
    void target.then((id: string) =>
      navigate(`${sessionHref(ServerConnection.key(server.conn), id)}${location.search}${location.hash}`, {
        replace: true,
      }),
    )
  })

  return null
}
