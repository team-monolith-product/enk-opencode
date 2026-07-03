import z from "zod"
import { spawn } from "node:child_process"
import { createConnection } from "node:net"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Log } from "@/util/log"

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

/**
 * Dev 서버(ensure_dev_server) 커맨드를 프로젝트 디렉토리(EFS)에 기록해 두었다가,
 * pod 재스폰 후 서버 부팅 시 그대로 재실행한다.
 *
 * 갤러리 미리보기는 CHP 서브도메인이 pod:3000(dev 서버)으로 직접 라우팅하므로,
 * 방문자가 트리거한 스폰(클라이언트 접속 없음)에서도 dev 서버가 살아나야 한다.
 * 기록 파일은 AI 가 실제 LISTEN 을 확인한(started) 커맨드만 담는다.
 *
 * 재실행 대상 디렉토리는 스포너가 주입하는 ENK_PROJECT_DIRECTORY 만 신뢰한다.
 * (pod 는 EFS root 전체를 마운트하므로 스캔으로 찾지 않는다.)
 */
export namespace DevServerReplay {
  const log = Log.create({ service: "enk.dev-server-replay" })

  const STATE_FILE = join(".opencode", "dev-server.json")

  const State = z.object({
    cmd: z.string(),
    cwd: z.string(),
    port: z.number().int().positive(),
  })
  export type State = z.infer<typeof State>

  /**
   * 백그라운드 launch. detached + stdio:ignore + unref 로 OpenCode 프로세스가 stdout 파이프를
   * 잡지 않게 한다. 이게 빠지면 도구 호출이 반환되지 않고 응답 턴이 hang 된다.
   */
  export function spawnDetached(cmd: string, cwd: string) {
    const child = spawn("/bin/sh", ["-lc", cmd], {
      cwd,
      detached: true,
      stdio: "ignore",
      env: process.env,
    })
    child.unref()
    return child
  }

  /** 성공한 dev 서버 커맨드를 기록한다. 실패해도 도구 호출을 막지 않는다(로그만). */
  export async function record(projectDirectory: string, state: State) {
    const file = join(projectDirectory, STATE_FILE)
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, JSON.stringify(state, null, 2) + "\n")
      log.info("recorded dev server command", { file, port: state.port })
    } catch (err) {
      log.warn("failed to record dev server command", { file, err: String(err) })
    }
  }

  /** 부팅 시 기록된 커맨드를 재실행한다. 조건이 하나라도 어긋나면 조용히 건너뛴다. */
  export async function replay() {
    const projectDirectory = process.env["ENK_PROJECT_DIRECTORY"]
    if (!projectDirectory) return

    const file = join(projectDirectory, STATE_FILE)
    let state: State
    try {
      state = State.parse(JSON.parse(await readFile(file, "utf8")))
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

    const child = spawnDetached(state.cmd, state.cwd)
    log.info("replayed dev server", { pid: child.pid, port: state.port, cwd: state.cwd })
  }
}
