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

// /dev-server/* 라우트는 아직 SDK 코드젠(sdk.gen.ts)에 포함되지 않아, SDK 가 쓰는 것과 동일한 저수준 client 로
// 직접 호출한다. baseUrl·Basic auth·디렉토리 헤더(x-opencode-directory)를 createOpencodeClient 와 동일하게 세팅한다.
// (디렉토리는 헤더로 전달되고, 서버 WorkspaceRouterMiddleware 가 이 값으로 instance 컨텍스트를 잡는다 — GET/POST 공통.)
function devServerClient(opts: { server: ServerConnection.HttpBase; directory: string; fetch?: typeof fetch }) {
  return createClient({
    baseUrl: opts.server.url,
    throwOnError: true,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    headers: {
      ...basicAuth(opts.server),
      "x-opencode-directory": encodeURIComponent(opts.directory),
    },
  })
}

export type DevServerState = "none" | "starting" | "startable" | "ready" | "errored"

export type DevServerStatusResult = {
  state: DevServerState
  port?: number
  httpStatus?: number
}

export function getDevServerStatus(opts: {
  server: ServerConnection.HttpBase
  directory: string
  fetch?: typeof fetch
}): Promise<DevServerStatusResult> {
  return devServerClient(opts)
    .get({ url: "/dev-server/status" })
    .then((res) => res.data as DevServerStatusResult)
}

export type DevServerRestartResult = {
  status: "already_running" | "started" | "failed" | "no_command" | "already_starting"
  url?: string
  port?: number
  ms: number
  reason?: string
}

export function restartDevServer(opts: {
  server: ServerConnection.HttpBase
  directory: string
  fetch?: typeof fetch
}): Promise<DevServerRestartResult> {
  return devServerClient(opts)
    .post({ url: "/dev-server/restart" })
    .then((res) => res.data as DevServerRestartResult)
}

// /env-file/* 도 SDK 코드젠 미포함이라 devServerClient 와 같은 방식으로 호출한다.
// 서버는 키 이름·등록시각만 반환한다(값은 write-only — 어떤 응답에도 값이 실리지 않음).
type EnvFileOpts = { server: ServerConnection.HttpBase; directory: string; fetch?: typeof fetch }
type EnvFileKeys = { keys: string[]; updated_at?: Record<string, number> }
export type EnvKeyEntry = { name: string; updated_at?: number }

export function listEnvKeys(opts: EnvFileOpts): Promise<EnvKeyEntry[]> {
  return devServerClient(opts)
    .get({ url: "/env-file" })
    .then((res) => {
      const data = res.data as EnvFileKeys
      const stamp = data.updated_at ?? {}
      return data.keys.map((name) => ({ name, updated_at: stamp[name] }))
    })
}

export function saveEnvKeys(opts: EnvFileOpts, values: Record<string, string>): Promise<string[]> {
  return devServerClient(opts)
    .put({ url: "/env-file", body: { values } })
    .then((res) => (res.data as EnvFileKeys).keys)
}

export function deleteEnvKey(opts: EnvFileOpts, name: string): Promise<string[]> {
  return devServerClient(opts)
    .delete({ url: `/env-file/${name}` })
    .then((res) => (res.data as EnvFileKeys).keys)
}
