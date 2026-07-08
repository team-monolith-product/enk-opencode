import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { lazy } from "../../util/lazy"
import { Instance } from "../../project/instance"
import { DevServerReplay, probePort } from "../../enk/dev-server-replay"
import { ServeTargets } from "../../enk/serve-targets"
import { serveUrl } from "../../tool/ensure-dev-server"

const RESTART_READY_TIMEOUT_MS = 15000

async function waitForPort(port: number, timeoutMs: number, abort: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (abort.aborted) return false
    if (await probePort(port)) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

// 연타/멀티탭 대비 in-flight 가드(디렉토리별). read→set 사이에 await 가 없어 동시 요청 둘째는
// 반드시 already_starting 으로 빠진다(Node 단일 스레드라 이 구간은 원자적).
const getGuard = Instance.state<{ launching: boolean }>(() => ({ launching: false }))

type RestartResult = {
  status: "already_running" | "started" | "failed" | "no_command" | "already_starting"
  url?: string
  port?: number
  ms: number
  reason?: string
}

// UI("다시 시도")에서 부르는 dev 서버 재시작. ensure_dev_server 가 DevServerReplay 로 기록해 둔
// 커맨드를 그대로 재실행한다. 세션 디렉토리가 속한 서빙 타깃(본행사/튜토리얼)을 대상으로 한다.
async function restart(abort: AbortSignal): Promise<RestartResult> {
  const startedAt = Date.now()
  const ms = () => Date.now() - startedAt

  const target = ServeTargets.forCwd(Instance.directory)
  if (!target) return { status: "no_command", ms: ms() }

  const record = await DevServerReplay.loadRecord(target)
  if (!record) return { status: "no_command", port: target.port, ms: ms() }

  // 원자적 check→set: 이 두 줄 사이에 await 가 없어야 동시 요청 둘째가 반드시 already_starting 으로 빠진다.
  // probePort/launch 는 플래그를 세운 뒤에 하고, finally 로 반드시 되돌린다.
  const guard = getGuard()
  if (guard.launching) return { status: "already_starting", port: target.port, ms: ms() }
  guard.launching = true
  try {
    if (await probePort(target.port)) {
      return { status: "already_running", url: serveUrl(target.port, target), port: target.port, ms: ms() }
    }
    DevServerReplay.launch(record.cmd, record.cwd)
    const ready = await waitForPort(target.port, RESTART_READY_TIMEOUT_MS, abort)
    if (!ready) {
      return {
        status: "failed",
        port: target.port,
        ms: ms(),
        reason: `포트 ${target.port} 가 ${RESTART_READY_TIMEOUT_MS}ms 안에 LISTEN 되지 않았습니다: ${record.cmd}`,
      }
    }
    return { status: "started", url: serveUrl(target.port, target), port: target.port, ms: ms() }
  } finally {
    getGuard().launching = false
  }
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
// - none:      서빙 타깃/기록 없음 → 아직 미리보기 서버가 없음(재시도 무의미)
// - starting:  launch 진행 중이거나, 포트는 열렸는데 아직 응답 없음(기동 중)
// - startable: 기록은 있는데 포트가 안 열림 → 재시작하면 뜰 수 있음(다시 시도)
// - ready:     포트 열림 + HTTP <500
// - errored:   포트 열림 + HTTP >=500 → 실행됐지만 오류
async function status(): Promise<StatusResult> {
  const target = ServeTargets.forCwd(Instance.directory)
  if (!target) return { state: "none" }
  if (getGuard().launching) return { state: "starting", port: target.port }
  if (!(await probePort(target.port))) {
    const record = await DevServerReplay.loadRecord(target)
    return { state: record ? "startable" : "none", port: target.port }
  }
  const httpStatus = await selfProbeHttp(target.port)
  if (httpStatus === undefined) return { state: "starting", port: target.port }
  if (httpStatus >= 500) return { state: "errored", port: target.port, httpStatus }
  return { state: "ready", port: target.port, httpStatus }
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
