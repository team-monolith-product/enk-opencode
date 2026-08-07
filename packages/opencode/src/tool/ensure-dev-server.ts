import z from "zod"
import { existsSync } from "node:fs"
import { networkInterfaces } from "node:os"
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

const HOST_HINT =
  "서버가 루프백(127.0.0.1)에만 바인딩돼 있어 미리보기 주소로는 열리지 않습니다. " +
  "쓰는 프레임워크에서 모든 주소(0.0.0.0)에 바인딩하는 옵션을 찾아 cmd 에 넣고 restart: true 로 다시 호출하세요."

/**
 * 컨테이너 밖에서 닿는 주소로도 LISTEN 중인지 본다.
 *
 * `--host` 없이 띄운 Vite/Nuxt 계열은 127.0.0.1 에만 바인딩되는데, probePort 는 루프백을 보므로
 * "떠 있음"으로 통과하고 정작 CHP 를 거치는 실제 미리보기는 실패한다. 이 괴리를 도구가 직접 알려주지
 * 않으면 학생이 매번 "안 열려요" 를 반복하게 된다. 비루프백 주소가 없는 로컬 개발에서는 undefined.
 *
 * 후보 주소가 여럿이면 전부 찔러 하나라도 닿으면 true 다. 첫 주소만 보면 인터페이스가 둘 이상인
 * 파드에서 엉뚱한 쪽을 집어 "루프백 전용" 오탐이 날 수 있는데, /dev-server/status 가 이 신호로
 * 미리보기를 아예 막으므로(errored) 오탐 비용이 hint 를 붙이던 때보다 크다.
 */
export async function reachableExternally(port: number): Promise<boolean | undefined> {
  const hosts = Object.values(networkInterfaces())
    .flat()
    .flatMap((info) => (info && info.family === "IPv4" && !info.internal ? [info.address] : []))
  if (!hosts.length) return undefined
  const reached = await Promise.all(hosts.map((host) => probePort(port, host)))
  return reached.some(Boolean)
}

export const EnsureDevServerTool = Tool.define("ensure_dev_server", async () => ({
  description: DESCRIPTION,
  parameters: z.object({
    cwd: z.string().describe(`서버를 실행할 작업 디렉토리 (기본값 ${Instance.directory})`).optional(),
    cmd: z
      .string()
      .describe("실행할 셸 명령. 예: 'npm run dev -- --host 0.0.0.0 --port 3000', 'npx --yes serve -l 3000 .'"),
    port: z.number().describe("서버가 LISTEN 할 포트. OpenCode 환경에서는 3000 고정.").default(3000),
    ready_timeout_ms: z.number().describe("새로 띄울 때 LISTEN 시작을 기다리는 최대 시간(ms).").default(15000),
    restart: z
      .boolean()
      .describe(
        "true 면 포트를 잡고 있는 기존 서버를 종료하고 cmd 로 새로 띄운다. " +
          "cmd 를 고쳤거나 미리보기가 오류일 때 사용. bash 로 직접 죽이고 띄우지 말고 이 인자를 쓴다.",
      )
      .default(false),
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
      recorded_cmd?: string
      hint?: string
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

    const existing = await DevServerReplay.loadRecord(Instance.directory)
    const running = await probePort(params.port)

    if (running && !params.restart) {
      // 기록은 "재기동하면 이대로 뜬다" 는 약속이므로 검증된 커맨드만 담는다. 지금 떠 있는 서버가
      // params.cmd 로 떴다는 보장이 없어 덮어쓰지 않고, 기록이 아예 없을 때만 백필한다.
      // 대신 어긋난 사실을 그대로 돌려줘 restart 로 정리하도록 유도한다 — 조용히 덮어쓰면
      // 기록만 바뀌고 실제 프로세스는 옛 커맨드 그대로여서 재스폰 때 같은 실패가 되돌아온다.
      if (!existing) await DevServerReplay.record(Instance.directory, { cmd: params.cmd, cwd, port: params.port })

      const hints: string[] = []
      if (existing && existing.cmd !== params.cmd)
        hints.push(
          "실행 중인 서버는 기록된 명령으로 떠 있어 이번 cmd 는 반영되지 않았습니다. " +
            "이 cmd 로 바꾸려면 restart: true 로 다시 호출하세요.",
        )
      if ((await reachableExternally(params.port)) === false) hints.push(HOST_HINT)

      return result(`ensure_dev_server: already_running (:${params.port})`, {
        status: "already_running",
        url: serveUrl(params.port),
        port: params.port,
        ms: Date.now() - startedAt,
        ...(existing && existing.cmd !== params.cmd ? { recorded_cmd: existing.cmd } : {}),
        ...(hints.length ? { hint: hints.join(" ") } : {}),
      })
    }

    // 권한 게이트는 bash 와 동일한 채널로 받는다. 학생 환경에선 opencode.jsonc 의 "permission": "allow" 로 자동 통과.
    await ctx.ask({
      permission: "bash",
      patterns: [params.cmd],
      always: [`ensure_dev_server :${params.port}`],
      metadata: {},
    })

    if (running) {
      const stopped = await DevServerReplay.stop(params.port, existing?.pid)
      if (!stopped) {
        return result("ensure_dev_server: failed", {
          status: "failed",
          port: params.port,
          ms: Date.now() - startedAt,
          reason: `포트 ${params.port} 를 점유한 기존 프로세스를 종료하지 못했습니다. 학생에게 어떤 프로세스가 포트를 쓰고 있는지 확인이 필요하다고 안내하세요.`,
        })
      }
      log.info("stopped previous dev server for restart", { port: params.port })
    }

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

    // 여기까지 왔으면 이 커맨드로 실제 LISTEN 까지 확인됐다 — 기록을 갱신할 자격이 있는 유일한 지점.
    await DevServerReplay.record(Instance.directory, { cmd: params.cmd, cwd, port: params.port, pid: child.pid })

    return result(`ensure_dev_server: started (:${params.port}, ${ms}ms)`, {
      status: "started",
      url: serveUrl(params.port),
      port: params.port,
      ms,
      ...((await reachableExternally(params.port)) === false ? { hint: HOST_HINT } : {}),
    })
  },
}))
