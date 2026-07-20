import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { lazy } from "../../util/lazy"
import { Instance } from "../../project/instance"
import { DevServerReplay, probePort } from "../../enk/dev-server-replay"
import { serveUrl } from "../../tool/ensure-dev-server"

type RestartResult = DevServerReplay.StartResult & { url?: string }

// UI("다시 시도")에서 부르는 dev 서버 재시작. 서버 부팅 시 자동 1회 실행과 같은 경로를 쓴다.
async function restart(abort: AbortSignal): Promise<RestartResult> {
  const result = await DevServerReplay.start({ directory: Instance.directory, abort })
  if (result.status === "already_running" || result.status === "started") {
    return { ...result, url: serveUrl(result.port!) }
  }
  return result
}

// 서버가 로컬로 dev 서버를 직접 찔러 실제 HTTP 상태를 얻는다 — CHP/CORS 모호함 없는 권위 있는 신호.
async function selfProbeHttp(port: number): Promise<number | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })
    return res.status
  } catch {
    return undefined
  }
}

type PreviewState = "none" | "starting" | "startable" | "ready" | "errored"
type StatusResult = { state: PreviewState; port?: number; httpStatus?: number }

// 미리보기 상태 5분기 — 클라이언트가 이 판정으로 fallback UI 를 고른다.
// - none:      기록 없고 포트도 안 열림 → 아직 미리보기 서버가 없음(재시도 무의미)
// - starting:  launch 진행 중이거나, 포트는 열렸는데 아직 응답 없음(기동 중)
// - startable: 기록은 있는데 포트가 안 열림 → 재시작하면 뜰 수 있음(다시 시도)
// - ready:     포트 열림 + HTTP <500
// - errored:   포트 열림 + HTTP >=500 → 실행됐지만 오류
async function status(): Promise<StatusResult> {
  const record = await DevServerReplay.loadRecord(Instance.directory)
  const port = record?.port ?? 3000
  if (DevServerReplay.isLaunching(Instance.directory)) return { state: "starting", port }
  if (!(await probePort(port))) {
    return record ? { state: "startable", port } : { state: "none" }
  }
  const httpStatus = await selfProbeHttp(port)
  if (httpStatus === undefined) return { state: "starting", port }
  if (httpStatus >= 500) return { state: "errored", port, httpStatus }
  return { state: "ready", port, httpStatus }
}

export const DevServerRoutes = lazy(() =>
  new Hono()
    .get(
      "/status",
      describeRoute({
        summary: "Preview dev server status",
        description:
          "Report the preview dev server state so the client can pick the right fallback UI: " +
          "none | starting | startable | ready | errored. The server self-probes http://127.0.0.1:PORT to get an authoritative HTTP status.",
        operationId: "devServer.status",
        responses: {
          200: {
            description: "Dev server status",
            content: {
              "application/json": {
                schema: resolver(
                  z
                    .object({
                      state: z.enum(["none", "starting", "startable", "ready", "errored"]),
                      port: z.number().optional(),
                      httpStatus: z.number().optional(),
                    })
                    .meta({ ref: "DevServerStatus" }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await status())
      },
    )
    .post(
      "/restart",
      describeRoute({
        summary: "Restart dev server",
        description:
          "Restart the preview dev server by replaying the command recorded by the last ensure_dev_server call. " +
          "Idempotent: returns already_starting while a launch is in progress and already_running if the port is already listening, so it is safe to call repeatedly.",
        operationId: "devServer.restart",
        responses: {
          200: {
            description: "Dev server restart result",
            content: {
              "application/json": {
                schema: resolver(
                  z
                    .object({
                      status: z.enum(["already_running", "started", "failed", "no_command", "already_starting"]),
                      url: z.string().optional(),
                      port: z.number().optional(),
                      ms: z.number(),
                      reason: z.string().optional(),
                    })
                    .meta({ ref: "DevServerRestart" }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await restart(c.req.raw.signal))
      },
    ),
)
