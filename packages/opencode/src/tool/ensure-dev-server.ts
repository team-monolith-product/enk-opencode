import z from "zod"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { Tool } from "./tool"
import DESCRIPTION from "./ensure-dev-server.txt"
import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { DevServerReplay, probePort } from "../enk/dev-server-replay"

export { probePort }

const log = Log.create({ service: "ensure-dev-server" })

async function waitForPort(port: number, timeoutMs: number, abort: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (abort.aborted) return false
    if (await probePort(port)) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

export function serveUrl(port: number): string {
  // 학생에게 안내할 외부 접근 주소. JUPYTERHUB_USER/OPENCODE_SERVE_DOMAIN 환경변수가 있으면 외부 URL,
  // 없으면 로컬 URL 로 폴백.
  const user = process.env["JUPYTERHUB_USER"]
  const domain = process.env["OPENCODE_SERVE_DOMAIN"]
  if (user && domain) return `https://${user}.${domain}/`
  return `http://localhost:${port}/`
}

export const EnsureDevServerTool = Tool.define("ensure_dev_server", async () => ({
  description: DESCRIPTION,
  parameters: z.object({
    cwd: z.string().describe(`서버를 실행할 작업 디렉토리 (기본값 ${Instance.directory})`).optional(),
    cmd: z
      .string()
      .describe(
        "실행할 셸 명령. 예: 'npm run dev -- --host 0.0.0.0 --port 3000', 'npx --yes serve -l 3000 .'",
      ),
    port: z.number().describe("서버가 LISTEN 할 포트. OpenCode 환경에서는 3000 고정.").default(3000),
    ready_timeout_ms: z.number().describe("새로 띄울 때 LISTEN 시작을 기다리는 최대 시간(ms).").default(15000),
  }),
  async execute(params, ctx) {
    const startedAt = Date.now()
    // replay 는 부팅 프로세스(다른 cwd)에서 도므로 절대경로로 고정해 기록한다.
    const cwd = resolve(params.cwd ?? Instance.directory)

    type Payload = {
      status: "already_running" | "started" | "failed"
      url?: string
      port: number
      ms: number
      reason?: string
    }

    const result = (title: string, payload: Payload) => ({
      title,
      output: JSON.stringify(payload),
      metadata: payload,
    })

    if (!existsSync(cwd)) {
      return result("ensure_dev_server: failed", {
        status: "failed",
        port: params.port,
        ms: Date.now() - startedAt,
        reason: `cwd 가 존재하지 않습니다: ${cwd}`,
      })
    }

    if (await probePort(params.port)) {
      // 이미 떠 있어도 기록은 갱신한다. 서버를 bash 로 먼저 띄웠거나 부팅 replay 로
      // 살아난 경우에도 재스폰 시 replay 가 동작하도록, 그리고 커맨드가 바뀌었으면 최신화한다.
      await DevServerReplay.record(Instance.directory, { cmd: params.cmd, cwd, port: params.port })
      return result(`ensure_dev_server: already_running (:${params.port})`, {
        status: "already_running",
        url: serveUrl(params.port),
        port: params.port,
        ms: Date.now() - startedAt,
      })
    }

    // 권한 게이트는 bash 와 동일한 채널로 받는다. 학생 환경에선 opencode.jsonc 의 "permission": "allow" 로 자동 통과.
    await ctx.ask({
      permission: "bash",
      patterns: [params.cmd],
      always: [`ensure_dev_server :${params.port}`],
      metadata: {},
    })

    const child = DevServerReplay.launch(params.cmd, cwd, { dir: Instance.directory })
    log.info("spawned dev server", { pid: child.pid, port: params.port, cwd })

    const ready = await waitForPort(params.port, params.ready_timeout_ms, ctx.abort)
    const ms = Date.now() - startedAt

    if (!ready) {
      return result("ensure_dev_server: failed", {
        status: "failed",
        port: params.port,
        ms,
        reason: `포트 ${params.port} 가 ${params.ready_timeout_ms}ms 안에 LISTEN 되지 않았습니다. 명령어를 확인하세요: ${params.cmd}`,
      })
    }

    await DevServerReplay.record(Instance.directory, { cmd: params.cmd, cwd, port: params.port })

    return result(`ensure_dev_server: started (:${params.port}, ${ms}ms)`, {
      status: "started",
      url: serveUrl(params.port),
      port: params.port,
      ms,
    })
  },
}))
