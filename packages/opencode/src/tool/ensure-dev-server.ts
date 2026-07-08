import z from "zod"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { Tool } from "./tool"
import DESCRIPTION from "./ensure-dev-server.txt"
import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { launch, probePort } from "../enk/dev-server-launch"
import { ServeTargets } from "../enk/serve-targets"

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

export function serveUrl(port: number, target?: ServeTargets.Target): string {
  // 학생에게 안내할 외부 접근 주소. JUPYTERHUB_USER/OPENCODE_SERVE_DOMAIN 환경변수가 있으면 외부 URL,
  // 없으면 로컬 URL 로 폴백. 튜토리얼은 CHP 가 :3001 로 라우팅하는 전용 서브도메인을 쓴다.
  const user = process.env["JUPYTERHUB_USER"]
  const domain = process.env["OPENCODE_SERVE_DOMAIN"]
  if (user && domain) {
    const suffix = target?.kind === "tutorial" ? ServeTargets.TUTORIAL_HOST_SUFFIX : ""
    return `https://${user}${suffix}.${domain}/`
  }
  return `http://localhost:${port}/`
}

export const EnsureDevServerTool = Tool.define("ensure_dev_server", async () => ({
  description: DESCRIPTION,
  parameters: z.object({
    cwd: z.string().describe(`서버를 실행할 작업 디렉토리 (기본값 ${Instance.directory})`).optional(),
    cmd: z
      .string()
      .describe(
        "실행할 셸 명령. 포트는 도구 결과의 port 와 일치해야 한다. " +
          "예: 'npm run dev -- --host 0.0.0.0 --port 3000 --strictPort', 'npx --yes serve -l 3000 .'",
      ),
    port: z
      .number()
      .describe("서버가 LISTEN 할 포트. 본행사 3000 / 튜토리얼 3001 — cwd 기준으로 도구가 강제한다.")
      .default(3000),
    ready_timeout_ms: z.number().describe("새로 띄울 때 LISTEN 시작을 기다리는 최대 시간(ms).").default(15000),
  }),
  async execute(params, ctx) {
    const startedAt = Date.now()
    // replay 는 부팅 프로세스(다른 cwd)에서 도므로 절대경로로 고정해 기록한다.
    const cwd = resolve(params.cwd ?? Instance.directory)

    // 포트는 AI 인자가 아니라 cwd 의 서빙 타깃이 결정한다(본행사 3000/튜토리얼 3001).
    // 미리보기 서브도메인·재부팅 replay·CHP 라우팅이 모두 이 규약에 묶여 있으므로
    // 모델이 다른 값을 넘겨도 여기서 교정한다.
    const target = ServeTargets.forCwd(cwd)
    const port = target?.port ?? params.port
    if (port !== params.port) {
      log.info("port overridden by serve target", { requested: params.port, port, kind: target?.kind, cwd })
    }

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
        port,
        ms: Date.now() - startedAt,
        reason: `cwd 가 존재하지 않습니다: ${cwd}`,
      })
    }

    if (await probePort(port)) {
      return result(`ensure_dev_server: already_running (:${port})`, {
        status: "already_running",
        url: serveUrl(port, target),
        port,
        ms: Date.now() - startedAt,
      })
    }

    // 권한 게이트는 이 도구 자신의 이름으로 받는다. 학생 환경에선 opencode.jsonc 의
    // "permission": "allow" 로 자동 통과하고, 내부 부팅 세션(DevServerAgent)은 ruleset 에서
    // ensure_dev_server 를 allow 하므로 통과한다. bash 로 받으면 그 세션의 전면 deny 에 막혀
    // 도구가 거부되어 서버를 못 띄운다.
    await ctx.ask({
      permission: "ensure_dev_server",
      patterns: [params.cmd],
      always: [`ensure_dev_server :${port}`],
      metadata: {},
    })

    const child = launch(params.cmd, cwd)
    log.info("spawned dev server", { pid: child.pid, port, cwd })

    const ready = await waitForPort(port, params.ready_timeout_ms, ctx.abort)
    const ms = Date.now() - startedAt

    if (!ready) {
      return result("ensure_dev_server: failed", {
        status: "failed",
        port,
        ms,
        reason:
          `포트 ${port} 가 ${params.ready_timeout_ms}ms 안에 LISTEN 되지 않았습니다. ` +
          `이 디렉토리의 서버는 반드시 ${port} 포트로 띄워야 합니다(cmd 의 포트 확인): ${params.cmd}`,
      })
    }

    return result(`ensure_dev_server: started (:${port}, ${ms}ms)`, {
      status: "started",
      url: serveUrl(port, target),
      port,
      ms,
    })
  },
}))
