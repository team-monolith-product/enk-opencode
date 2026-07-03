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

    const child = launch(state.cmd, state.cwd)
    log.info("replayed dev server", { pid: child.pid, port: state.port, cwd: state.cwd })
  }
}
