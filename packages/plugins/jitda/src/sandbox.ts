import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// 에이전트 셸을 OS 격리 안에서 돌린다. 셸이 opencode 와 같은 uid 로 도는 한 /proc/<pid>/mem·ptrace 로 opencode 힙을,
// 데이터 디렉터리로 auth.json·세션 DB 를 읽을 수 있다.
//   linux: bubblewrap. --unshare-pid 로 다른 프로세스를 안 보이게 하고 데이터 디렉터리를 tmpfs 로 덮는다.
//   darwin: sandbox-exec 로 파일 접근만 막는다(로컬 개발용).
// OPENCODE_SANDBOX=off(기본)·auto·require. 백엔드가 실제로 도는지 부팅 때 한 번 재 본다.

export type Backend = "none" | "bwrap" | "sandbox-exec"
export type Mode = "off" | "auto" | "require"

export function mode(env: NodeJS.ProcessEnv = process.env): Mode {
  const value = env.OPENCODE_SANDBOX?.toLowerCase()
  return value === "auto" || value === "require" ? value : "off"
}

export function hidden(env: NodeJS.ProcessEnv = process.env) {
  const data = path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode")
  try {
    return [realpathSync(data)]
  } catch {
    return [data]
  }
}

function bwrap(cwd: string, dirs: string[]) {
  return [
    "bwrap",
    "--dev-bind",
    "/",
    "/",
    "--unshare-pid",
    "--proc",
    "/proc",
    ...dirs.flatMap((dir) => ["--tmpfs", dir]),
    "--die-with-parent",
    "--chdir",
    cwd,
    "--",
  ]
}

function profile(dirs: string[]) {
  const deny = dirs.map((dir) => `(subpath ${JSON.stringify(dir)})`).join(" ")
  return `(version 1)(allow default)(deny file-read* file-write* ${deny})`
}

let detected: Backend | undefined

export function backend(env: NodeJS.ProcessEnv = process.env): Backend {
  if (detected) return detected
  if (mode(env) === "off") return (detected = "none")
  if (process.platform === "darwin") {
    const out = spawnSync("sandbox-exec", ["-p", "(version 1)(allow default)", "true"])
    detected = out.status === 0 ? "sandbox-exec" : "none"
  } else if (process.platform === "linux") {
    const [command, ...args] = bwrap("/", hidden(env))
    const out = spawnSync(command!, [...args, "true"])
    detected = out.status === 0 ? "bwrap" : "none"
  } else detected = "none"
  console.warn(`[jitda.sandbox] sandbox backend ${detected} (mode ${mode(env)})`)
  return detected
}

export function reset() {
  detected = undefined
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

export function script(found: Exclude<Backend, "none">, shell: string, dirs: string[]) {
  const prefix =
    found === "bwrap"
      ? bwrap("$PWD", dirs).map((part) => (part === "$PWD" ? '"$PWD"' : quote(part)))
      : ["sandbox-exec", "-p", quote(profile(dirs))]
  return `#!/bin/sh\nexec ${prefix.join(" ")} ${quote(shell)} "$@"\n`
}

const wrappers = new Map<string, string>()

// 셸 경로를 원래 셸을 격리 안에서 실행하는 래퍼 스크립트로 바꾼다. 셸은 `셸 -c 명령` 으로 불리므로 인자를 그대로 넘긴다.
export function wrap(shell: string, env: NodeJS.ProcessEnv = process.env) {
  const found = backend(env)
  if (found === "none") {
    if (mode(env) === "require")
      throw new Error("OPENCODE_SANDBOX=require but no usable sandbox backend was found on this host")
    return shell
  }
  const cached = wrappers.get(shell)
  if (cached) return cached
  const dir = path.join(os.tmpdir(), `jitda-sandbox-${process.pid}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, createHash("sha1").update(shell).digest("hex").slice(0, 12))
  writeFileSync(file, script(found, shell, hidden(env)), { mode: 0o700 })
  chmodSync(file, 0o700)
  wrappers.set(shell, file)
  return file
}

export * as Sandbox from "./sandbox"
