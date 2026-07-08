import { spawn } from "node:child_process"
import { createConnection } from "node:net"
import { existsSync } from "node:fs"
import { Instance } from "../project/instance"
import { Log } from "../util/log"

const log = Log.create({ service: "dev-server" })

/**
 * 지정 포트가 LISTEN 중인지 빠르게 확인한다.
 * lsof/ss/netstat 없이 TCP connect 시도만으로 판별 — `(echo > /dev/tcp/...)` 의 Node 버전.
 */
export function probePort(port: number, host = "127.0.0.1", timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port })
    const done = (ok: boolean) => {
      sock.removeAllListeners()
      sock.destroy()
      resolve(ok)
    }
    sock.once("connect", () => done(true))
    sock.once("error", () => done(false))
    sock.setTimeout(timeoutMs, () => done(false))
  })
}

export async function waitForPort(port: number, timeoutMs: number, abort: AbortSignal): Promise<boolean> {
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

export type DevServerStatus = "already_running" | "started" | "failed" | "no_command" | "already_starting"

export type DevServerResult = {
  status: DevServerStatus
  url?: string
  port: number
  ms: number
  reason?: string
}

/**
 * 마지막으로 실행된 dev 서버 파라미터 + 진행 중 여부. UI 의 "다시 시도" 버튼이 재시작할 때
 * cmd 를 기억해두기 위한 디렉토리별 상태다. Instance 재로드 시 함께 정리된다.
 */
type DevServerState = { cmd?: string; cwd?: string; port: number; launching: boolean }

const getState = Instance.state<DevServerState>(() => ({ port: 3000, launching: false }))

export function state(): DevServerState {
  return getState()
}

/**
 * detached 백그라운드로 dev 서버를 띄우고 포트가 LISTEN 될 때까지만 폴링한다.
 *
 * 연타/멀티탭 대비 원자적 가드: `launching` read→set 사이에 await 가 없어 동시에 들어온 둘째 호출은
 * 반드시 `already_starting` 으로 빠진다(중복 spawn 차단). Node 단일 스레드라 이 구간은 원자적이다.
 */
export async function launch(params: {
  cmd: string
  cwd: string
  port: number
  timeoutMs: number
  abort: AbortSignal
}): Promise<DevServerResult> {
  const startedAt = Date.now()
  const s = getState()
  if (s.launching) return { status: "already_starting", port: params.port, ms: 0 }
  s.launching = true
  s.cmd = params.cmd
  s.cwd = params.cwd
  s.port = params.port
  try {
    // 백그라운드 launch. detached + stdio:ignore + unref 로 OpenCode 프로세스가 stdout 파이프를 잡지 않게 한다.
    // 이게 빠지면 호출이 반환되지 않고 hang 된다.
    const child = spawn("/bin/sh", ["-lc", params.cmd], {
      cwd: params.cwd,
      detached: true,
      stdio: "ignore",
      env: process.env,
    })
    child.unref()
    log.info("spawned dev server", { pid: child.pid, port: params.port, cwd: params.cwd })

    const ready = await waitForPort(params.port, params.timeoutMs, params.abort)
    const ms = Date.now() - startedAt
    if (!ready) {
      return {
        status: "failed",
        port: params.port,
        ms,
        reason: `포트 ${params.port} 가 ${params.timeoutMs}ms 안에 LISTEN 되지 않았습니다. 명령어를 확인하세요: ${params.cmd}`,
      }
    }
    return { status: "started", url: serveUrl(params.port), port: params.port, ms }
  } finally {
    getState().launching = false
  }
}

/**
 * UI(다시 시도 버튼)에서 부르는 재시작. 마지막 ensure_dev_server 호출이 기억해둔 cmd/cwd/port 로 재시작한다.
 * - 기억된 cmd 가 없으면 `no_command` (아직 AI 가 미리보기 서버를 띄운 적 없음).
 * - launch 진행 중이면 `already_starting` (연타/중복 spawn 차단).
 * - 이미 LISTEN 중이면 `already_running` (재탐색만으로 복구 가능 → 클라이언트가 iframe 만 리로드).
 * - 그 외에는 새로 launch.
 */
export async function restart(params: { timeoutMs: number; abort: AbortSignal }): Promise<DevServerResult> {
  const startedAt = Date.now()
  const s = getState()
  if (s.launching) return { status: "already_starting", port: s.port, ms: 0 }
  if (!s.cmd || !s.cwd) return { status: "no_command", port: s.port, ms: Date.now() - startedAt }
  if (!existsSync(s.cwd)) {
    return {
      status: "failed",
      port: s.port,
      ms: Date.now() - startedAt,
      reason: `cwd 가 존재하지 않습니다: ${s.cwd}`,
    }
  }
  if (await probePort(s.port)) {
    return { status: "already_running", url: serveUrl(s.port), port: s.port, ms: Date.now() - startedAt }
  }
  return launch({ cmd: s.cmd, cwd: s.cwd, port: s.port, timeoutMs: params.timeoutMs, abort: params.abort })
}
