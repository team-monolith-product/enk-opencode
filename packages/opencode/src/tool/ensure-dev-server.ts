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

/**
 * 이 프로세스가 보는 비루프백 IPv4 주소들 — 파드 밖에서 이 포트로 들어올 때 쓰이는 주소.
 *
 * cli/cmd/web.ts 의 getNetworkIPs 와 달리 172.x 를 거르지 않는다. 거기서는 Docker 브리지를
 * 접속 안내에서 빼려는 것이지만, EKS 파드 IP 는 VPC CIDR(대개 172.16–31.x)에서 나오므로
 * 같은 필터를 쓰면 학생 환경에서 후보가 0개가 돼 판정 자체가 불가능해진다.
 */
function externalAddresses(): string[] {
  const out: string[] = []
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.internal || info.family !== "IPv4") continue
      out.push(info.address)
    }
  }
  return out
}

/**
 * 포트가 루프백 말고 외부 주소로도 열려 있는지.
 *
 * 미리보기는 CHP 서브도메인이 pod:3000 으로 라우팅하므로, `--host 0.0.0.0` 없이 띄운 Vite/Nuxt 처럼
 * 127.0.0.1 에만 바인드된 서버는 LISTEN 중이어도 학생 화면에는 안 뜬다. probePort(127.0.0.1) 로는
 * 구분이 안 되니 비루프백 주소로 한 번 더 찔러 본다.
 *
 * 후보 주소가 하나도 없으면(네트워크가 격리된 로컬/CI 등) 판정을 포기하고 true 를 돌려준다 —
 * 오탐으로 정상 서버를 막는 쪽이 놓치는 쪽보다 나쁘다.
 */
export async function reachableExternally(port: number): Promise<boolean> {
  const addresses = externalAddresses()
  if (addresses.length === 0) return true
  const reached = await Promise.all(addresses.map((host) => probePort(port, host)))
  return reached.some(Boolean)
}

function loopbackOnlyReason(port: number, cmd: string): string {
  return (
    `포트 ${port} 가 LISTEN 중이지만 루프백(127.0.0.1)에만 바인드돼 있어 미리보기 주소로는 닿지 않습니다. ` +
    `학생 화면에는 빈 iframe 만 보입니다. 커맨드에 호스트 바인딩을 추가해 다시 띄우세요 ` +
    `(Vite/CRA 는 --host 0.0.0.0, Next.js 는 --hostname 0.0.0.0): ${cmd}. ` +
    `이미 떠 있는 프로세스를 먼저 종료해야 새 바인딩이 적용됩니다: kill $(lsof -t -i:${port})`
  )
}

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
      status: "already_running" | "started" | "failed" | "loopback_only"
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
      // 남이 띄운 서버일 수도 있으니(부팅 replay·bash) 여기서도 바인딩을 확인한다.
      if (!(await reachableExternally(params.port))) {
        return result(`ensure_dev_server: loopback_only (:${params.port})`, {
          status: "loopback_only",
          port: params.port,
          ms: Date.now() - startedAt,
          reason: loopbackOnlyReason(params.port, params.cmd),
        })
      }
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

    const child = DevServerReplay.launch(params.cmd, cwd)
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

    // LISTEN 은 됐지만 루프백 전용이면 미리보기로는 못 쓴다 — started 로 보고하면 AI 가 성공으로
    // 착각하고, 학생만 빈 화면을 본다. 여기서 바로 원인과 고칠 커맨드를 돌려준다.
    if (!(await reachableExternally(params.port))) {
      return result(`ensure_dev_server: loopback_only (:${params.port}, ${ms}ms)`, {
        status: "loopback_only",
        port: params.port,
        ms,
        reason: loopbackOnlyReason(params.port, params.cmd),
      })
    }

    return result(`ensure_dev_server: started (:${params.port}, ${ms}ms)`, {
      status: "started",
      url: serveUrl(params.port),
      port: params.port,
      ms,
    })
  },
}))
