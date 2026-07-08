import z from "zod"
import { existsSync } from "node:fs"
import { Tool } from "./tool"
import DESCRIPTION from "./ensure-dev-server.txt"
import { Instance } from "../project/instance"
import * as DevServer from "./dev-server"

// 기존 import 경로 호환(테스트 등)을 위해 공유 모듈의 헬퍼를 재노출한다.
export { probePort, serveUrl } from "./dev-server"

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
    ready_timeout_ms: z
      .number()
      .describe("새로 띄울 때 LISTEN 시작을 기다리는 최대 시간(ms).")
      .default(15000),
  }),
  async execute(params, ctx) {
    const startedAt = Date.now()
    const cwd = params.cwd ?? Instance.directory
    const port = params.port

    const result = (title: string, payload: DevServer.DevServerResult) => ({
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

    // UI(다시 시도 버튼)에서 재시작할 수 있도록 마지막 cmd/cwd/port 를 기억해둔다. 이미 떠 있어도 기억한다.
    const s = DevServer.state()
    s.cmd = params.cmd
    s.cwd = cwd
    s.port = port

    if (await DevServer.probePort(port)) {
      return result(`ensure_dev_server: already_running (:${port})`, {
        status: "already_running",
        url: DevServer.serveUrl(port),
        port,
        ms: Date.now() - startedAt,
      })
    }

    // 권한 게이트는 bash 와 동일한 채널로 받는다. 학생 환경에선 opencode.jsonc 의 "permission": "allow" 로 자동 통과.
    await ctx.ask({
      permission: "bash",
      patterns: [params.cmd],
      always: [`ensure_dev_server :${port}`],
      metadata: {},
    })

    const r = await DevServer.launch({
      cmd: params.cmd,
      cwd,
      port,
      timeoutMs: params.ready_timeout_ms,
      abort: ctx.abort,
    })

    const title =
      r.status === "started"
        ? `ensure_dev_server: started (:${port}, ${r.ms}ms)`
        : r.status === "already_starting"
          ? `ensure_dev_server: already_starting (:${port})`
          : "ensure_dev_server: failed"
    return result(title, r)
  },
}))
