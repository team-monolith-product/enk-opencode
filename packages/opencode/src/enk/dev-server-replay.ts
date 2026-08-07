import z from "zod"
import { spawn } from "node:child_process"
import { createConnection } from "node:net"
import { existsSync } from "node:fs"
import { readdir, readlink, readFile } from "node:fs/promises"
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
    // 우리가 띄운 프로세스의 pid. detached spawn 이라 pgid 와 같아 그룹째 종료할 때 쓴다.
    // 커맨드를 바꿔 재기동하려면 포트를 잡은 프로세스를 먼저 내려야 하는데, 학생 런타임에는
    // lsof/fuser 가 없어 이 값이 사실상 유일하게 확실한 단서다. 옛 기록에는 없어 optional.
    pid: z.number().int().positive().optional(),
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

  /** 프로세스가 살아있는지. signal 0 은 시그널을 보내지 않고 존재/권한만 확인한다. */
  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /** 프로세스 그룹째 종료한다. launch 가 detached 라 pgid == pid — npm 이 띄운 손자 프로세스까지 함께 내려간다. */
  function killGroup(pid: number, signal: NodeJS.Signals) {
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        process.kill(pid, signal)
      } catch {}
    }
  }

  /**
   * 포트를 LISTEN 중인 프로세스 pid 를 /proc 로 찾는다. 기록에 pid 가 없는 경우
   * (옛 기록이거나, AI 가 bash 로 직접 띄운 서버)의 폴백이다.
   *
   * 학생 런타임 이미지(node:22-slim + procps)에는 lsof 도 fuser 도 없어 셸 도구를 쓸 수 없다.
   * Linux 가 아니거나 권한이 없으면 빈 배열 — 호출부는 "못 찾음"으로만 다룬다.
   */
  async function pidsListeningOn(port: number): Promise<number[]> {
    const inodes = new Set<string>()
    for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      let raw: string
      try {
        raw = await readFile(table, "utf8")
      } catch {
        continue
      }
      for (const line of raw.split("\n").slice(1)) {
        // 컬럼: sl(0) local_address(1) rem_address(2) st(3) ... inode(9). st 0A 가 LISTEN.
        const cols = line.trim().split(/\s+/)
        if (cols.length < 10 || cols[3] !== "0A") continue
        if (parseInt(cols[1]!.split(":")[1] ?? "", 16) !== port) continue
        inodes.add(cols[9]!)
      }
    }
    if (inodes.size === 0) return []

    let entries: string[]
    try {
      entries = await readdir("/proc")
    } catch {
      return []
    }
    const pids: number[] = []
    for (const entry of entries) {
      const pid = Number(entry)
      // 자기 자신은 절대 죽이지 않는다. OpenCode 서버가 그 포트를 잡은 경우라면 재기동 대상이 아니다.
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue
      let fds: string[]
      try {
        fds = await readdir(`/proc/${pid}/fd`)
      } catch {
        continue
      }
      for (const fd of fds) {
        let link: string
        try {
          link = await readlink(`/proc/${pid}/fd/${fd}`)
        } catch {
          continue
        }
        const inode = link.match(/^socket:\[(\d+)\]$/)?.[1]
        if (inode && inodes.has(inode)) {
          pids.push(pid)
          break
        }
      }
    }
    return pids
  }

  /** 프로세스의 pgid. /proc 이 없으면 undefined. */
  async function pgidOf(pid: number): Promise<number | undefined> {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8")
      // comm 에 공백·괄호가 들어갈 수 있어 마지막 ')' 뒤부터 자른다. 그 뒤 필드는 state, ppid, pgrp 순.
      const pgrp = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2])
      return Number.isInteger(pgrp) && pgrp > 0 ? pgrp : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 포트를 잡고 있는 dev 서버를 종료한다. 커맨드를 바꿔 다시 띄우려면 먼저 자리를 비워야 한다.
   *
   * 죽일 대상은 보수적으로 고른다. 기록된 pid 는 pod 재스폰 뒤 무관한 프로세스에 재사용됐을 수
   * 있어, /proc 이 그 pid 를 점유 프로세스의 그룹 리더로 확인해 줄 때만 그룹째 죽인다(그래야 npm 이
   * 띄운 자식까지 정리된다). 확인이 안 되면 /proc 이 짚어준 점유 프로세스만 건드리고, /proc 자체가
   * 없으면(로컬 개발) 기록된 pid 로 폴백한다.
   *
   * 성공 판정 기준은 "포트가 실제로 닫혔는가" 하나 — 시그널 전달 여부가 아니다.
   */
  export async function stop(port: number, pid?: number, timeoutMs = 5000): Promise<boolean> {
    if (!(await probePort(port))) return true

    const holders = await pidsListeningOn(port)
    const recorded = pid && pid !== process.pid && alive(pid) ? pid : undefined
    const leadsHolders = recorded !== undefined && (await Promise.all(holders.map(pgidOf))).includes(recorded)
    const targets = holders.length === 0 ? (recorded ? [recorded] : []) : leadsHolders ? [recorded!] : holders

    if (targets.length === 0) {
      log.warn("no killable process found for port", { port })
      return false
    }

    for (const [signal, budget] of [
      ["SIGTERM", timeoutMs],
      ["SIGKILL", 2000],
    ] as const) {
      for (const target of targets) killGroup(target, signal)
      const deadline = Date.now() + budget
      while (Date.now() < deadline) {
        if (!(await probePort(port))) {
          log.info("stopped dev server", { port, targets, signal })
          return true
        }
        await new Promise((r) => setTimeout(r, 200))
      }
    }
    return !(await probePort(port))
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
    // 기록의 pid 는 항상 "지금 포트를 잡고 있는 프로세스" 여야 한다. 여기서 갱신하지 않으면
    // 재스폰 뒤 stop() 이 죽은 옛 pid 를 들고 폴백으로 새는 일이 생긴다.
    if (child.pid) await record(dir, { ...state, pid: child.pid })
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
