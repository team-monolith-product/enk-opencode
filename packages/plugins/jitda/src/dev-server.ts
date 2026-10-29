import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, open, readdir, readFile, readlink, stat, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { networkInterfaces } from "node:os"
import { dirname, resolve } from "node:path"
import { Env } from "./env"
import { ServeTargets } from "./serve-targets"

// ensure_dev_server 가 LISTEN 까지 확인한 커맨드를 서빙 타깃 디렉터리(EFS)에 기록해 두었다가, pod 가 다시 뜰 때 그대로
// 재실행한다. 갤러리 미리보기는 CHP 가 pod:3000/3001 로 직결하므로 방문자가 띄운 스폰에서도 dev 서버가 살아나야 한다.

const FILE = ".opencode/dev-server.json"
const LOG_FILE = ".opencode/dev-server.log"
const LOG_TAIL_BYTES = 64 * 1024
const RESTART_READY_TIMEOUT_MS = 15_000

export type State = { cmd: string; cwd: string; port: number; pid?: number }

const log = (message: string, extra?: Record<string, unknown>) =>
  console.warn(`[jitda.dev-server] ${message}`, extra ?? "")

export function probePort(port: number, host = "127.0.0.1", timeoutMs = 250): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ host, port })
    const settle = (ok: boolean) => {
      socket.removeAllListeners("connect")
      socket.removeAllListeners("timeout")
      socket.on("error", () => {})
      socket.destroy()
      done(ok)
    }
    socket.once("connect", () => settle(true))
    socket.once("error", () => settle(false))
    socket.setTimeout(timeoutMs, () => settle(false))
  })
}

export async function waitForPort(port: number, timeoutMs: number, signal?: AbortSignal) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) return false
    if (await probePort(port)) return true
    await new Promise((done) => setTimeout(done, 300))
  }
  return false
}

// 컨테이너 밖 주소로도 LISTEN 중인지. --host 없이 띄운 서버는 루프백만 잡아 미리보기(CHP)가 실패한다.
// 비루프백 주소가 없으면(로컬 개발) 판정 불가라 undefined.
export async function reachableExternally(port: number) {
  const hosts = Object.values(networkInterfaces())
    .flat()
    .flatMap((info) => (info && info.family === "IPv4" && !info.internal ? [info.address] : []))
  if (!hosts.length) return undefined
  return (await Promise.all(hosts.map((host) => probePort(port, host)))).some(Boolean)
}

export function serveUrl(port: number, kind: ServeTargets.Kind = "project") {
  const host = ServeTargets.previewHost(kind)
  return host ? `${host}/` : `http://localhost:${port}/`
}

const stateDir = (cwd: string, fallback: string) => ServeTargets.forCwd(cwd)?.dir ?? fallback
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

export function logFile(cwd: string, fallback = cwd) {
  return resolve(stateDir(cwd, fallback), LOG_FILE)
}

// detached + stdio ignore + unref 라 도구 호출이 출력 파이프를 잡지 않는다. 출력은 셸 리다이렉트로 로그 파일에 남기고
// launch 마다 비운다. 환경은 ChildEnv allowlist 에 프로젝트 .env 값을 얹는다(UI 로 저장한 시크릿이 앱에 닿게).
export async function launch(cmd: string, cwd: string, options?: { dir?: string }) {
  const file = logFile(cwd, options?.dir ?? cwd)
  const script = `mkdir -p ${quote(dirname(file))} 2>/dev/null; : > ${quote(file)} 2>/dev/null; {\n${cmd}\n} >> ${quote(file)} 2>&1`
  const child = spawn("/bin/sh", ["-lc", script], {
    cwd,
    detached: true,
    stdio: "ignore",
    env: Env.sanitize({ extend: await Env.load(cwd) }),
  })
  child.on("error", (error) => log("dev server spawn failed", { cwd, error: String(error) }))
  child.unref()
  return child
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {}
  }
}

// 포트를 LISTEN 중인 pid 를 /proc 로 찾는다. 학생 런타임에는 lsof/fuser 가 없다. Linux 가 아니면 빈 배열.
async function pidsListeningOn(port: number) {
  const inodes = new Set<string>()
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const raw = await readFile(table, "utf8").catch(() => undefined)
    if (!raw) continue
    for (const line of raw.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 10 || cols[3] !== "0A") continue
      if (parseInt(cols[1]!.split(":")[1] ?? "", 16) !== port) continue
      inodes.add(cols[9]!)
    }
  }
  if (inodes.size === 0) return []
  const entries = await readdir("/proc").catch(() => [] as string[])
  const pids: number[] = []
  for (const entry of entries) {
    const pid = Number(entry)
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue
    const fds = await readdir(`/proc/${pid}/fd`).catch(() => [] as string[])
    for (const fd of fds) {
      const link = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => "")
      const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1]
      if (inode && inodes.has(inode)) {
        pids.push(pid)
        break
      }
    }
  }
  return pids
}

async function pgidOf(pid: number) {
  const raw = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined)
  if (!raw) return undefined
  const pgrp = Number(raw.slice(raw.lastIndexOf(")") + 2).split(" ")[2])
  return Number.isInteger(pgrp) && pgrp > 0 ? pgrp : undefined
}

// 포트를 잡은 dev 서버를 내린다. 기록된 pid 는 재사용됐을 수 있어 /proc 이 그 pid 를 점유 프로세스의 그룹 리더로 확인할
// 때만 그룹째 죽이고, 아니면 점유 프로세스만, /proc 이 없으면 기록된 pid 로 폴백한다. 성공은 포트가 닫혔는가로만 본다.
export async function stop(port: number, pid?: number, timeoutMs = 5000) {
  if (!(await probePort(port))) return true
  const holders = await pidsListeningOn(port)
  const recorded = pid && pid !== process.pid && alive(pid) ? pid : undefined
  const leads = recorded !== undefined && (await Promise.all(holders.map(pgidOf))).includes(recorded)
  const targets = holders.length === 0 ? (recorded ? [recorded] : []) : leads ? [recorded!] : holders
  if (targets.length === 0) return false
  for (const [signal, budget] of [
    ["SIGTERM", timeoutMs],
    ["SIGKILL", 2000],
  ] as const) {
    for (const target of targets) killGroup(target, signal)
    const deadline = Date.now() + budget
    while (Date.now() < deadline) {
      if (!(await probePort(port))) return true
      await new Promise((done) => setTimeout(done, 200))
    }
  }
  return !(await probePort(port))
}

export async function record(dir: string, state: State) {
  const file = resolve(stateDir(state.cwd, dir), FILE)
  await mkdir(dirname(file), { recursive: true })
    .then(() => writeFile(file, JSON.stringify(state, null, 2) + "\n"))
    .catch((error) => log("failed to record dev server command", { file, error: String(error) }))
}

function parseState(value: unknown): State | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const { cmd, cwd, port, pid } = value as Record<string, unknown>
  if (typeof cmd !== "string" || typeof cwd !== "string") return undefined
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) return undefined
  if (pid !== undefined && (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)) return undefined
  return { cmd, cwd, port, ...(pid === undefined ? {} : { pid }) }
}

// cwd 가 속한 타깃의 기록. 다른 타깃의 cwd 를 담은 기록은 없는 것으로 본다(엉뚱한 앱을 살리거나 죽이지 않게).
export async function loadRecord(cwd: string) {
  const target = ServeTargets.forCwd(cwd)
  const raw = await readFile(resolve(stateDir(cwd, cwd), FILE), "utf8").catch(() => undefined)
  const state = raw === undefined ? undefined : parseState(JSON.parse(raw === "" ? "null" : raw))
  if (!state) return undefined
  if (target && ServeTargets.forCwd(state.cwd)?.kind !== target.kind) return undefined
  return state
}

async function replayTarget(target: ServeTargets.Target) {
  const state = await loadRecord(target.dir).catch(() => undefined)
  if (!state || !existsSync(state.cwd)) return
  if (await probePort(state.port)) return
  const child = await launch(state.cmd, state.cwd, { dir: target.dir })
  if (child.pid) await record(target.dir, { ...state, pid: child.pid })
}

// 부팅 때 본행사·튜토리얼 기록을 각각 재실행한다. 조건이 하나라도 어긋나면 조용히 건너뛴다.
export async function replay(env: NodeJS.ProcessEnv = process.env) {
  for (const target of [ServeTargets.project(env), ServeTargets.tutorial(env)]) {
    if (target) await replayTarget(target).catch((error) => log("replay failed", { error: String(error) }))
  }
}

const ANSI = new RegExp("\\u001b\\[[0-9;?]*[ -/]*[@-~]|\\u001b[@-Z\\\\-_]", "g")

export async function readLog(options: { dir: string; lines?: number }) {
  const file = logFile(options.dir)
  const limit = Math.max(1, Math.min(options.lines ?? 40, 500))
  const info = await stat(file).catch(() => undefined)
  if (!info?.size) return []
  const handle = await open(file, "r")
  try {
    const start = Math.max(0, info.size - LOG_TAIL_BYTES)
    const buffer = Buffer.alloc(info.size - start)
    await handle.read(buffer, 0, buffer.length, start)
    const rows = buffer
      .toString("utf8")
      .split("\n")
      .map((line) => (line.includes("\r") ? (line.split("\r").at(-1) ?? "") : line))
      .map((line) => line.replace(ANSI, "").trimEnd())
    if (info.size > LOG_TAIL_BYTES) rows.shift()
    return rows.filter((line) => line.length > 0).slice(-limit)
  } finally {
    await handle.close()
  }
}

async function selfProbeHttp(port: number) {
  return fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }).then(
    (res) => res.status,
    () => undefined,
  )
}

export type PreviewState = "none" | "starting" | "startable" | "ready" | "errored"

const launching = new Set<string>()

// 미리보기 상태 5분기. loopbackOnly 는 클라이언트가 스스로 구분할 수 없어서 서버가 errored 로 접는다.
export async function status(directory: string) {
  const target = ServeTargets.forCwd(directory)
  const state = await loadRecord(directory)
  const port = target?.port ?? state?.port ?? ServeTargets.PORTS.project
  if (launching.has(directory)) return { state: "starting" as PreviewState, port }
  if (!(await probePort(port)))
    return state ? { state: "startable" as PreviewState, port } : { state: "none" as PreviewState }
  const httpStatus = await selfProbeHttp(port)
  if (httpStatus === undefined) return { state: "starting" as PreviewState, port }
  if (httpStatus >= 500) return { state: "errored" as PreviewState, port, httpStatus }
  if ((await reachableExternally(port)) === false) return { state: "errored" as PreviewState, port, loopbackOnly: true }
  return { state: "ready" as PreviewState, port, httpStatus }
}

// UI 의 "다시 시도". 기록된 커맨드를 그대로 재실행한다. 연타·여러 탭에 대비해 디렉터리별로 한 번만 띄운다.
export async function restart(directory: string, signal?: AbortSignal) {
  const started = Date.now()
  const ms = () => Date.now() - started
  const target = ServeTargets.forCwd(directory)
  const state = await loadRecord(directory)
  if (!state) return { status: "no_command" as const, ms: ms() }
  const port = target?.port ?? state.port
  if (launching.has(directory)) return { status: "already_starting" as const, port, ms: ms() }
  launching.add(directory)
  try {
    if (await probePort(port))
      return { status: "already_running" as const, url: serveUrl(port, target?.kind), port, ms: ms() }
    const child = await launch(state.cmd, state.cwd, { dir: directory })
    if (child.pid) await record(directory, { ...state, pid: child.pid })
    if (!(await waitForPort(port, RESTART_READY_TIMEOUT_MS, signal)))
      return {
        status: "failed" as const,
        port,
        ms: ms(),
        reason: `포트 ${port} 가 ${RESTART_READY_TIMEOUT_MS}ms 안에 LISTEN 되지 않았습니다: ${state.cmd}`,
      }
    return { status: "started" as const, url: serveUrl(port, target?.kind), port, ms: ms() }
  } finally {
    launching.delete(directory)
  }
}

export * as DevServer from "./dev-server"
