import type { DevServerStatusResult } from "./dev-server"

// 서버 루프백 프로브와 클라(CHP 경유) 판정이 어긋날 수 있는 none/startable 에서만 클라 도달 체크를 본다.
// errored 는 서버 HTTP 프로브가 권위 있으므로 덮지 않는다(재시도·AI 수정 안내가 보여야 한다).
export function needsReachabilityProbe(server: DevServerStatusResult | undefined): boolean {
  return !!server && (server.state === "none" || server.state === "startable")
}

export function resolvePreviewState(
  server: DevServerStatusResult | undefined,
  reachable: boolean,
): DevServerStatusResult {
  if (!server || server.state === "starting" || server.state === "ready") return server ?? { state: "starting" }
  if (server.state === "errored") return server
  return reachable ? { state: "ready", port: server.port } : server
}
