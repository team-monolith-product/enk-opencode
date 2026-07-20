import z from "zod"
import { spawn } from "node:child_process"
import { createConnection } from "node:net"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { Log } from "@/util/log"

/**
 * 지정 포트가 LISTEN 중인지 빠르게 확인한다.
 * lsof/ss/netstat 없이 TCP connect 시도만으로 판별 — `(echo > /dev/tcp/...)` 의 Node 버전.
 */
export function probePort(port: number, host = "127.0.0.1", timeoutMs = 250): Promise<boolean> {
  return new Promise((done) => {
    const sock = createConnection({ host, port })
    // connect 직후 도착하는 RST 등 뒤늦은 'error' 가 리스너 없는 예외로 던져지지 않도록
    // destroy 전에 no-op 리스너를 남겨둔다(replay 는 부팅 경로라 uncaught 가 치명적).
    const settle = (ok: boolean) => {
      sock.removeAllListeners("connect")
      sock.removeAllListeners("timeout")
      sock.on("error", () => {})
      sock.destroy()
      done(ok)
    }
    sock.once("connect", () => settle(true))
    sock.once("error", () => settle(false))
    sock.setTimeout(timeoutMs, () => settle(false))
  })
}

/**
 * Dev 서버(ensure_dev_server) 커맨드를 프로젝트 디렉토리(EFS)에 기록해 두었다가,
 * pod 재스폰 후 서버 부팅 시 그대로 재실행한다.
 *
 * 갤러리 미리보기는 CHP 서브도메인이 pod:3000(dev 서버)으로 직접 라우팅하므로,
 * 방문자가 트리거한 스폰(클라이언트 접속 없음)에서도 dev 서버가 살아나야 한다.
 * 기록 파일은 AI 가 실행을 확인한 커맨드만 담는다.
 *
 * 기록 위치는 항상 stateDir() — 스포너가 주입한 ENK_PROJECT_DIRECTORY 가 있으면 그곳으로
 * 통일한다. 세션이 하위 폴더(git 루트)나 tutorial-directory 에서 열려도 record 와 replay 가
 * 같은 파일을 보도록 하기 위함이다. 재실행 cwd 는 서버가 실제로 돌던 위치를 그대로 쓴다.
 */
export namespace DevServerReplay {
  const log = Log.create({ service: "enk.dev-server-replay" })

  const FILE = ".opencode/dev-server.json"

  const State = z.object({
    cmd: z.string(),
    cwd: z.string(),
    port: z.number().int().positive(),
  })
  export type State = z.infer<typeof State>

  /** 기록 파일이 놓일 디렉토리. 스포너 주입 경로를 최우선으로 한다. */
  function stateDir(fallback?: string): string | undefined {
    return process.env["ENK_PROJECT_DIRECTORY"] ?? fallback
  }

  /**
   * 백그라운드 launch. detached + stdio:ignore + unref 로 OpenCode 프로세스가 stdout 파이프를
   * 잡지 않게 한다. 이게 빠지면 도구 호출이 반환되지 않고 응답 턴이 hang 된다.
   *
   * 'error' 리스너가 없으면 비동기 spawn 실패(ENOENT/EAGAIN 등)가 uncaught 예외가 되는데,
   * replay 는 부팅 경로에서 fire-and-forget 로 돌아 프로세스를 죽이므로 반드시 처리한다.
   */
  export function launch(cmd: string, cwd: string) {
    const child = spawn("/bin/sh", ["-lc", cmd], {
      cwd,
      detached: true,
      stdio: "ignore",
      env: process.env,
    })
    child.on("error", (err) => log.warn("dev server spawn failed", { cwd, err: String(err) }))
    child.unref()
    return child
  }

  /** 성공한 dev 서버 커맨드를 기록한다. 실패해도 도구 호출을 막지 않는다(로그만). */
  export async function record(dir: string, state: State) {
    const target = stateDir(dir)
    if (!target) return
    const file = resolve(target, FILE)
    try {
      await Bun.write(file, JSON.stringify(state, null, 2) + "\n")
      log.info("recorded dev server command", { file, port: state.port })
    } catch (err) {
      log.warn("failed to record dev server command", { file, err: String(err) })
    }
  }

  export type StartResult = {
    status: "already_running" | "started" | "failed" | "no_command" | "already_starting"
    port?: number
    ms: number
    reason?: string
  }

  const READY_TIMEOUT_MS = 15000

  // 디렉토리별 in-flight 가드. UI("다시 시도") 요청 경로와 부팅 경로가 같은 맵을 봐야 부팅 launch 중
  // 들어온 요청이 already_starting 으로 빠지고 status() 도 starting 을 보고하므로 모듈 스코프에 둔다.
  const launching = new Set<string>()

  export function isLaunching(fallback?: string) {
    const dir = stateDir(fallback)
    return dir ? launching.has(dir) : false
  }

  async function waitForPort(port: number, timeoutMs: number, abort?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (abort?.aborted) return false
      if (await probePort(port)) return true
      await new Promise((r) => setTimeout(r, 300))
    }
    return false
  }

  /**
   * 기록된 커맨드로 dev 서버를 띄운다. UI 의 "다시 시도" 버튼과 서버 부팅이 함께 쓰는 단일 경로.
   * 멱등: 이미 떠 있으면 already_running, 기동 중이면 already_starting 을 돌려주므로 반복 호출이 안전하다.
   */
  export async function start(
    opts: { directory?: string; abort?: AbortSignal; readyTimeoutMs?: number } = {},
  ): Promise<StartResult> {
    const readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS
    const startedAt = Date.now()
    const ms = () => Date.now() - startedAt

    const record = await loadRecord(opts.directory)
    if (!record) return { status: "no_command", ms: ms() }

    // 원자적 check→set: 이 두 줄 사이에 await 가 없어야 동시 요청 둘째가 반드시 already_starting 으로 빠진다.
    // probePort/launch 는 플래그를 세운 뒤에 하고, finally 로 반드시 되돌린다.
    const key = stateDir(opts.directory)!
    if (launching.has(key)) return { status: "already_starting", port: record.port, ms: ms() }
    launching.add(key)
    try {
      if (await probePort(record.port)) {
        return { status: "already_running", port: record.port, ms: ms() }
      }
      if (!existsSync(record.cwd)) {
        return {
          status: "failed",
          port: record.port,
          ms: ms(),
          reason: `기록된 cwd 가 존재하지 않습니다: ${record.cwd}`,
        }
      }
      const child = launch(record.cmd, record.cwd)
      log.info("launched dev server", { pid: child.pid, port: record.port, cwd: record.cwd })
      if (!(await waitForPort(record.port, readyTimeoutMs, opts.abort))) {
        return {
          status: "failed",
          port: record.port,
          ms: ms(),
          reason: `포트 ${record.port} 가 ${readyTimeoutMs}ms 안에 LISTEN 되지 않았습니다: ${record.cmd}`,
        }
      }
      return { status: "started", port: record.port, ms: ms() }
    } finally {
      launching.delete(key)
    }
  }

  /** 기록된 dev 서버 커맨드를 반환한다. 없거나 파싱 실패면 undefined. UI 재시작 등에서 재사용. */
  export async function loadRecord(fallback?: string): Promise<State | undefined> {
    const dir = stateDir(fallback)
    if (!dir) return undefined
    try {
      return State.parse(await Bun.file(resolve(dir, FILE)).json())
    } catch {
      return undefined
    }
  }
}
