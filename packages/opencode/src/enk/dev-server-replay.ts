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
   * 'error' 리스너가 없으면 비동기 spawn 실패(ENOENT/EAGAIN 등)가 uncaught 예외가 되는데,
   * 부팅 경로에서 fire-and-forget 로 돌아 프로세스를 죽이므로 반드시 처리한다.
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

  // `설치 && 서브` 형태 커맨드의 선행 설치 단계. yarn 은 bare 호출도 설치라 별도 처리.
  const INSTALL_STEP =
    /^\s*(?:(?:npm\s+(?:install|ci)|pnpm\s+(?:install|i)|bun\s+install|yarn\s+install)(?:\s|$)|yarn\s*$)/

  /**
   * 기록된 커맨드에서 선행 설치 단계(npm install && ...)를 제거하고 서브 커맨드만 남긴다.
   * EFS 에서는 no-op 설치도 stat 폭풍으로 분 단위 CPU 를 점유해, 부팅마다 재실행되면
   * 인스턴스 부트스트랩이 기아 상태에 빠져 IDE API 가 504 로 죽는다. 설치가 전부라
   * 서브 커맨드가 남지 않으면 빈 문자열을 반환한다.
   */
  export function stripInstallSteps(cmd: string): string {
    const parts = cmd.split("&&")
    let start = 0
    while (start < parts.length && INSTALL_STEP.test(parts[start])) start++
    return parts.slice(start).join("&&").trim()
  }

  /**
   * 타깃에 재실행 가능한 기록이 있으면 반환한다 — "유효한 기록" 판정의 단일 진실.
   * 파싱 실패, cwd 소멸, cwd 가 다른 타깃 소속(규약 이전 레거시 기록), 설치 단계만
   * 남은 커맨드면 undefined 를 반환하고, 호출부(DevServerBoot)가 폴백으로 처리한다.
   * 반환되는 cmd 는 설치 단계가 제거된 재실행용 커맨드다.
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
    const cmd = stripInstallSteps(state.cmd)
    if (!cmd) {
      log.warn("recorded cmd has no serve step after stripping installs, falling back", { file, cmd: state.cmd })
      return undefined
    }
    if (cmd !== state.cmd) {
      log.info("stripped install steps from recorded cmd", { file, cmd })
    }
    return { ...state, cmd }
  }
}
