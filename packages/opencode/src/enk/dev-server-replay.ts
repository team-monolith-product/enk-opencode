import z from "zod"
import { spawn } from "node:child_process"
import { createConnection } from "node:net"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
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
  const LOG_FILE = ".opencode/dev-server.log"

  /** 로그 tail 로 읽어 올 최대 바이트. 파일이 아무리 커져도 이 뒤쪽만 읽는다. */
  const LOG_TAIL_BYTES = 64 * 1024

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

  /** 셸 인자용 작은따옴표 이스케이프. 경로에 공백·따옴표가 있어도 리다이렉트가 깨지지 않게 한다. */
  function sq(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`
  }

  /** dev 서버 출력이 쌓이는 로그 파일 경로. 기록 파일과 같은 stateDir 을 쓴다. */
  export function logFile(fallback?: string): string | undefined {
    const dir = stateDir(fallback)
    return dir ? resolve(dir, LOG_FILE) : undefined
  }

  /**
   * 백그라운드 launch. detached + stdio:ignore + unref 로 OpenCode 프로세스가 stdout 파이프를
   * 잡지 않게 한다. 이게 빠지면 도구 호출이 반환되지 않고 응답 턴이 hang 된다.
   *
   * 출력은 Node 파이프 대신 셸 리다이렉트로 로그 파일에 남긴다(파이프를 안 잡으므로 hang 위험 없음).
   * 미리보기 대기/오류 화면이 이 파일을 tail 해서 보여준다. 커맨드가 `a && b` 같은 복합문일 수 있어
   * 중괄호 그룹으로 감싸 리다이렉트가 전체에 걸리게 하고, 매 launch 마다 파일을 비워 이번 실행의
   * 로그만 남긴다(무한 증가 방지). 로그 경로를 못 정하면 예전처럼 그냥 버린다.
   *
   * 'error' 리스너가 없으면 비동기 spawn 실패(ENOENT/EAGAIN 등)가 uncaught 예외가 되는데,
   * replay 는 부팅 경로에서 fire-and-forget 로 돌아 프로세스를 죽이므로 반드시 처리한다.
   */
  export function launch(cmd: string, cwd: string, opts?: { dir?: string }) {
    const file = logFile(opts?.dir ?? cwd)
    const script = file
      ? `mkdir -p ${sq(dirname(file))} 2>/dev/null; : > ${sq(file)} 2>/dev/null; {\n${cmd}\n} >> ${sq(file)} 2>&1`
      : cmd
    const child = spawn("/bin/sh", ["-lc", script], {
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

  /** 부팅 시 기록된 커맨드를 재실행한다. 조건이 하나라도 어긋나면 조용히 건너뛴다. */
  export async function replay() {
    const dir = stateDir()
    if (!dir) return

    const file = resolve(dir, FILE)
    let state: State
    try {
      state = State.parse(await Bun.file(file).json())
    } catch {
      return
    }

    if (!existsSync(state.cwd)) {
      log.warn("recorded cwd no longer exists, skipping replay", { cwd: state.cwd })
      return
    }
    if (await probePort(state.port)) {
      log.info("dev server already listening, skipping replay", { port: state.port })
      return
    }

    const child = launch(state.cmd, state.cwd, { dir })
    log.info("replayed dev server", { pid: child.pid, port: state.port, cwd: state.cwd })
  }

  // ANSI 이스케이프(색/커서 제어). vite 등 dev 서버 출력은 색이 섞여 오는데, 웹에서 그대로 그리면
  // 제어문자가 노출되므로 읽는 쪽에서 벗겨낸다.
  const ANSI = new RegExp("\\u001b\\[[0-9;?]*[ -\/]*[@-~]|\\u001b[@-Z\\\\-_]", "g")

  /**
   * dev 서버 로그의 마지막 N 줄. 진행률 표시(\r 로 덮어쓰는 줄)는 마지막 조각만 남기고,
   * ANSI 색코드는 벗긴다. 파일이 없거나 읽기 실패면 빈 배열.
   */
  export async function readLog(opts?: { dir?: string; lines?: number }): Promise<string[]> {
    const file = logFile(opts?.dir)
    if (!file) return []
    const limit = Math.max(1, Math.min(opts?.lines ?? 40, 500))
    try {
      const handle = Bun.file(file)
      const size = handle.size
      if (!size) return []
      const text = await handle.slice(Math.max(0, size - LOG_TAIL_BYTES)).text()
      const rows = text
        .split("\n")
        // \r 로 같은 줄을 덮어쓰는 진행률 출력은 마지막 상태만 의미가 있다.
        .map((line) => (line.includes("\r") ? (line.split("\r").at(-1) ?? "") : line))
        .map((line) => line.replace(ANSI, "").trimEnd())
      // 앞쪽 잘림(64KB 경계)으로 반쪽짜리가 된 첫 줄은 버린다.
      if (size > LOG_TAIL_BYTES) rows.shift()
      const trimmed = rows.filter((line) => line.length > 0)
      return trimmed.slice(-limit)
    } catch {
      return []
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
