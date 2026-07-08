import { spawn } from "node:child_process"
import { createConnection } from "node:net"
import { Log } from "@/util/log"

const log = Log.create({ service: "enk.dev-server-launch" })

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
 * 백그라운드 launch. detached + stdio:ignore + unref 로 OpenCode 프로세스가 stdout 파이프를
 * 잡지 않게 한다. 이게 빠지면 도구 호출이 반환되지 않고 응답 턴이 hang 된다.
 *
 * nice -n 19 로 최저 우선순위로 띄운다 — dev 서버 초기 빌드가 첫 IDE 로드와 CPU 를 경합해
 * 인스턴스 부트스트랩을 굶기지 않도록 IDE 에 CPU 를 양보하게 한다. nice 는 coreutils 표준이라
 * 이미지에 항상 있고, exec 로 셸을 대체해 불필요한 래퍼 프로세스를 남기지 않는다.
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
