import z from "zod"
import { spawn } from "node:child_process"
import { createConnection } from "node:net"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { Log } from "@/util/log"
import { ServeTargets } from "./serve-targets"

/**
 * 지정 포트가 LISTEN 중인지 빠르게 확인한다.
 * lsof/ss/netstat 없이 TCP connect 시도만으로 판별 — `(echo > /dev/tcp/...)` 의 Node 버전.
 */
export function probePort(port: number, host = "127.0.0.1", timeoutMs = 250): Promise<boolean> {
  return new Promise((done) => {
    const sock = createConnection({ host, port })
    // connect 직후 도착하는 RST 등 뒤늦은 'error' 가 리스너 없는 예외로 던져지지 않도록
    // destroy 전에 no-op 리스너를 남겨둔다(부팅 경로라 uncaught 가 치명적).
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
 * Dev 서버(ensure_dev_server) 커맨드의 기록 저장소 — 작업 디렉토리(EFS)에 기록해 두면
 * 부팅 오케스트레이션(DevServerBoot)이 pod 재스폰 후 그대로 재실행한다.
 *
 * 기록 위치는 cwd 가 속한 서빙 타깃 디렉토리(ServeTargets.forCwd) — 세션이 하위
 * 폴더(git 루트)에서 열려도 타깃(본행사/튜토리얼)별로 기록과 재실행이 같은 파일을
 * 본다. 재실행 cwd 는 서버가 실제로 돌던 위치를 그대로 쓴다.
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

  /** 기록 파일이 놓일 디렉토리. cwd 의 서빙 타깃을 우선하고, 규약 밖 경로면 fallback 을 쓴다. */
  function stateDir(cwd: string, fallback?: string): string | undefined {
    return ServeTargets.forCwd(cwd)?.dir ?? process.env["ENK_PROJECT_DIRECTORY"] ?? fallback
  }

  /**
   * 백그라운드 launch. detached + stdio:ignore + unref 로 OpenCode 프로세스가 stdout 파이프를
   * 잡지 않게 한다. 이게 빠지면 도구 호출이 반환되지 않고 응답 턴이 hang 된다.
   *
   * nice -n 19 로 최저 우선순위로 띄운다 — 부팅 직후 재실행/폴백이 첫 IDE 로드와 CPU 를
   * 경합해 인스턴스 부트스트랩을 기아 상태(504)로 만들지 않도록, 서버가 IDE 에 CPU 를
   * 양보하게 한다. install 이 포함된 커맨드도 이 우선순위 아래에서 돈다. nice 는 coreutils
   * 표준이라 이미지에 항상 있고, exec 로 셸을 대체해 불필요한 래퍼 프로세스를 남기지 않는다.
   *
   * 'error' 리스너가 없으면 비동기 spawn 실패(ENOENT/EAGAIN 등)가 uncaught 예외가 되는데,
   * 부팅 경로에서 fire-and-forget 로 돌아 프로세스를 죽이므로 반드시 처리한다.
   */
  export function launch(cmd: string, cwd: string) {
    const child = spawn("/bin/sh", ["-lc", `exec nice -n 19 /bin/sh -lc ${quote(cmd)}`], {
      cwd,
      detached: true,
      stdio: "ignore",
      env: process.env,
    })
    child.on("error", (err) => log.warn("dev server spawn failed", { cwd, err: String(err) }))
    child.unref()
    return child
  }

  /** POSIX 셸 단일 인용 — 내부 작은따옴표만 이스케이프하면 나머지는 리터럴로 안전하다. */
  function quote(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`
  }

  /** 성공한 dev 서버 커맨드를 기록한다. 실패해도 도구 호출을 막지 않는다(로그만). */
  export async function record(state: State, fallbackDir?: string) {
    const target = stateDir(state.cwd, fallbackDir)
    if (!target) return
    const file = resolve(target, FILE)
    try {
      await Bun.write(file, JSON.stringify(state, null, 2) + "\n")
      log.info("recorded dev server command", { file, port: state.port })
    } catch (err) {
      log.warn("failed to record dev server command", { file, err: String(err) })
    }
  }

  /**
   * 타깃에 재실행 가능한 기록이 있으면 그대로 반환한다 — "유효한 기록" 판정의 단일 진실.
   * 파싱 실패, cwd 소멸, cwd 가 다른 타깃 소속(규약 이전 레거시 기록)이면 undefined 를
   * 반환하고, 호출부(DevServerBoot)가 AI 폴백으로 재구축한다. 기록된 cmd 는 AI 가 판단해
   * 남긴 것이므로 손대지 않는다(부팅 부하는 launch 의 nice 로 흡수한다).
   */
  export async function loadRecord(target: ServeTargets.Target): Promise<State | undefined> {
    const file = resolve(target.dir, FILE)
    let state: State
    try {
      state = State.parse(await Bun.file(file).json())
    } catch {
      return undefined
    }
    if (ServeTargets.forCwd(state.cwd)?.kind !== target.kind) {
      log.warn("recorded cwd belongs to another target, falling back", { file, cwd: state.cwd })
      return undefined
    }
    if (!existsSync(state.cwd)) {
      log.warn("recorded cwd no longer exists, falling back", { cwd: state.cwd })
      return undefined
    }
    return state
  }
}
