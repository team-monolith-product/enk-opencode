import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createClient } from "@opencode-ai/sdk/v2/gen/client"
import type { ServerConnection } from "@/context/server"

function basicAuth(server: ServerConnection.HttpBase) {
  if (!server.password) return
  return {
    Authorization: `Basic ${btoa(`${server.username ?? "opencode"}:${server.password}`)}`,
  }
}

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createOpencodeClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  return createOpencodeClient({
    ...config,
    headers: { ...config.headers, ...basicAuth(server) },
    baseUrl: server.url,
  })
}

export type DevServerRestartResult = {
  status: "already_running" | "started" | "failed" | "no_command" | "already_starting"
  url?: string
  port?: number
  ms: number
  reason?: string
}

// POST /dev-server/restart 는 아직 SDK 코드젠(sdk.gen.ts)에 포함되지 않아, SDK 가 쓰는 것과 동일한 저수준 client 로
// 직접 호출한다. baseUrl·Basic auth·디렉토리 헤더(x-opencode-directory)를 createOpencodeClient 와 동일하게 세팅한다.
// (POST 라 디렉토리는 헤더로 전달되고, 서버 WorkspaceRouterMiddleware 가 이 값으로 instance 컨텍스트를 잡는다.)
export function restartDevServer(opts: {
  server: ServerConnection.HttpBase
  directory: string
  fetch?: typeof fetch
}): Promise<DevServerRestartResult> {
  const client = createClient({
    baseUrl: opts.server.url,
    throwOnError: true,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    headers: {
      ...basicAuth(opts.server),
      "x-opencode-directory": encodeURIComponent(opts.directory),
    },
  })
  return client.post({ url: "/dev-server/restart" }).then((res) => res.data as DevServerRestartResult)
}
