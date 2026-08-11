import z from "zod"
import { existsSync } from "node:fs"
import { networkInterfaces } from "node:os"
import { resolve } from "node:path"
import { Tool } from "./tool"
import DESCRIPTION from "./ensure-dev-server.txt"
import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { DevServerReplay, probePort } from "../enk/dev-server-replay"
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

export function serveUrl(port: number, kind?: ServeTargets.Kind): string {
  // 학생에게 안내할 외부 접근 주소. JUPYTERHUB_USER/OPENCODE_SERVE_DOMAIN 환경변수가 있으면 외부 URL,
  // 없으면 로컬 URL 로 폴백. 튜토리얼은 CHP 가 :3001 로 라우팅하는 전용 서브도메인을 쓴다.
  const user = process.env["JUPYTERHUB_USER"]
  const domain = process.env["OPENCODE_SERVE_DOMAIN"]
  if (user && domain) {
    const suffix = kind === "tutorial" ? ServeTargets.TUTORIAL_HOST_SUFFIX : ""
    return `https://${user}${suffix}.${domain}/`
  }
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

// 이 세션이 서빙하는 포트. cmd 안의 포트 옵션은 모델이 직접 적으므로, 스키마 기본값과
// 예시가 처음부터 이 값을 가리켜야 첫 호출이 바로 맞는다.
function servePort(): number {
  return ServeTargets.forCwd(Instance.directory)?.port ?? ServeTargets.PORTS.project
}

export const EnsureDevServerTool = Tool.define("ensure_dev_server", async () => ({
  description: DESCRIPTION,
  parameters: z.object({
    cwd: z.string().describe(`서버를 실행할 작업 디렉토리 (기본값 ${Instance.directory})`).optional(),
    cmd: z
      .string()
      .describe(
        `실행할 셸 명령. 포트는 반드시 ${servePort()} 로 적는다. ` +
          `예: 'npm run dev -- --host 0.0.0.0 --port ${servePort()}', 'npx --yes serve -l ${servePort()} .'`,
      ),
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

    // 포트는 인자가 아니라 cwd 의 서빙 타깃이 정한다(본행사 3000 / 튜토리얼 3001).
    // 미리보기 서브도메인·부팅 replay·CHP 라우팅이 모두 이 규약에 묶여 있다.
    const target = ServeTargets.forCwd(cwd)
    const port = target?.port ?? ServeTargets.PORTS.project

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
        port,
        ms: Date.now() - startedAt,
        reason: `cwd 가 존재하지 않습니다: ${cwd}`,
      })
    }

    const existing = await DevServerReplay.loadRecord(cwd)
    const running = await probePort(port)

    if (running && !params.restart) {
      // 기록은 "재기동하면 이대로 뜬다" 는 약속이므로 검증된 커맨드만 담는다. 지금 떠 있는 서버가
      // params.cmd 로 떴다는 보장이 없어 덮어쓰지 않고, 기록이 아예 없을 때만 백필한다.
      // 대신 어긋난 사실을 그대로 돌려줘 restart 로 정리하도록 유도한다 — 조용히 덮어쓰면
      // 기록만 바뀌고 실제 프로세스는 옛 커맨드 그대로여서 재스폰 때 같은 실패가 되돌아온다.
      if (!existing) await DevServerReplay.record(Instance.directory, { cmd: params.cmd, cwd, port })

      const hints: string[] = []
      if (existing && existing.cmd !== params.cmd)
        hints.push(
          "실행 중인 서버는 기록된 명령으로 떠 있어 이번 cmd 는 반영되지 않았습니다. " +
            "이 cmd 로 바꾸려면 restart: true 로 다시 호출하세요.",
        )
      if ((await reachableExternally(port)) === false) hints.push(HOST_HINT)

      return result(`ensure_dev_server: already_running (:${port})`, {
        status: "already_running",
        url: serveUrl(port, target?.kind),
        port,
        ms: Date.now() - startedAt,
        ...(existing && existing.cmd !== params.cmd ? { recorded_cmd: existing.cmd } : {}),
        ...(hints.length ? { hint: hints.join(" ") } : {}),
      })
    }

    // 권한 게이트는 bash 와 동일한 채널로 받는다. 학생 환경에선 opencode.jsonc 의 "permission": "allow" 로 자동 통과.
    await ctx.ask({
      permission: "bash",
      patterns: [params.cmd],
      always: [`ensure_dev_server :${port}`],
      metadata: {},
    })

    if (running) {
      const stopped = await DevServerReplay.stop(port, existing?.pid)
      if (!stopped) {
        return result("ensure_dev_server: failed", {
          status: "failed",
          port,
          ms: Date.now() - startedAt,
          reason: `포트 ${port} 를 점유한 기존 프로세스를 종료하지 못했습니다. 학생에게 어떤 프로세스가 포트를 쓰고 있는지 확인이 필요하다고 안내하세요.`,
        })
      }
      log.info("stopped previous dev server for restart", { port })
    }

    const child = DevServerReplay.launch(params.cmd, cwd)
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
          `cmd 가 ${port} 에 바인딩하는지 확인하세요: ${params.cmd}`,
      })
    }

    // 여기까지 왔으면 이 커맨드로 실제 LISTEN 까지 확인됐다 — 기록을 갱신할 자격이 있는 유일한 지점.
    await DevServerReplay.record(Instance.directory, { cmd: params.cmd, cwd, port, pid: child.pid })

    return result(`ensure_dev_server: started (:${port}, ${ms}ms)`, {
      status: "started",
      url: serveUrl(port, target?.kind),
      port,
      ms,
      ...((await reachableExternally(port)) === false ? { hint: HOST_HINT } : {}),
    })
  },
}))
