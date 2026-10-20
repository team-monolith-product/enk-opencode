// jitda.dev-server RPC 응답 모양(packages/plugins/jitda/src/dev-server.ts, dev-server-tool.ts).
export type DevServerState = "none" | "starting" | "startable" | "ready" | "errored"

export type DevServerStatusResult = {
  state: DevServerState
  port?: number
  httpStatus?: number
  loopbackOnly?: boolean
}

export type DevServerLogsResult = { lines: string[]; cmd?: string; port?: number }

export type DevServerRestartResult = {
  status: "started" | "already_running" | "already_starting" | "no_command" | "failed"
  url?: string
  port?: number
  reason?: string
}
