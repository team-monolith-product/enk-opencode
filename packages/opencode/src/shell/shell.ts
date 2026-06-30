import { Flag } from "@/flag/flag"
import { lazy } from "@/util/lazy"
import { Filesystem } from "@/util/filesystem"
import { which } from "@/util/which"
import path from "path"
import { spawn, type ChildProcess } from "child_process"
import { setTimeout as sleep } from "node:timers/promises"

const SIGKILL_TIMEOUT_MS = 200

export namespace Shell {
  const BLACKLIST = new Set(["fish", "nu"])
  const LOGIN = new Set(["bash", "dash", "fish", "ksh", "sh", "zsh"])
  const POSIX = new Set(["bash", "dash", "ksh", "sh", "zsh"])

  // Snapshot every transitive descendant of `root` by walking PPID links. setsid /
  // disown / "new session" children change their session and process group but NOT
  // their parent pid, so a PPID walk still reaches them — as long as the snapshot is
  // taken while the parent is alive (before it exits and they reparent to init).
  function descendants(root: number): Promise<Set<number>> {
    return new Promise((resolve) => {
      const ps = spawn("ps", ["-A", "-o", "pid=,ppid="], { stdio: ["ignore", "pipe", "ignore"] })
      let buf = ""
      ps.stdout.on("data", (d) => (buf += d.toString()))
      ps.once("error", () => resolve(new Set()))
      ps.once("close", () => {
        const children = new Map<number, number[]>()
        for (const line of buf.split("\n")) {
          const m = line.trim().match(/^(\d+)\s+(\d+)$/)
          if (!m) continue
          const childPid = Number(m[1])
          const parentPid = Number(m[2])
          const arr = children.get(parentPid)
          if (arr) arr.push(childPid)
          else children.set(parentPid, [childPid])
        }
        const out = new Set<number>()
        const stack = [root]
        while (stack.length) {
          const p = stack.pop()!
          for (const child of children.get(p) ?? []) {
            if (out.has(child) || child === root) continue
            out.add(child)
            stack.push(child)
          }
        }
        resolve(out)
      })
    })
  }

  export async function killTree(proc: ChildProcess, opts?: { exited?: () => boolean }): Promise<void> {
    const pid = proc.pid
    if (!pid) return

    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
          stdio: "ignore",
          windowsHide: true,
        })
        killer.once("exit", () => resolve())
        killer.once("error", () => resolve())
      })
      return
    }

    // Capture descendants up front, while the parent is still alive, so we can also
    // reach children that escaped the process group (setsid/disown/dev servers).
    const tree = await descendants(pid)

    // Send to the whole process group (negative pid). The final SIGKILL is sent
    // unconditionally: opts.exited only reflects the parent process, so a child
    // that ignores SIGTERM survives if we gate SIGKILL on the parent's exit.
    // Killing an already-empty group throws ESRCH, which we treat as success.
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-pid, signal)
        return true
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") return false
        // Group kill not possible (e.g. not a group leader): fall back to the
        // direct child. This misses grandchildren but is better than nothing.
        try {
          proc.kill(signal)
        } catch {
          /* already gone */
        }
        return false
      }
    }

    // Signal the captured descendants directly — catches the ones that left the group.
    const killTreePids = (signal: NodeJS.Signals) => {
      for (const p of tree) {
        try {
          process.kill(p, signal)
        } catch {
          /* already gone */
        }
      }
    }

    const alive = (p: number) => {
      try {
        process.kill(p, 0)
        return true
      } catch {
        return false
      }
    }
    // Anything still running in the group or among the captured descendants.
    const anyAlive = () => alive(-pid) || [...tree].some(alive)

    killGroup("SIGTERM")
    killTreePids("SIGTERM")
    // Skip the SIGKILL grace only when the parent reported exit AND nothing else
    // (group or escaped descendant) is still alive — i.e. the whole tree is gone.
    if (opts?.exited?.() && !anyAlive()) return
    await sleep(SIGKILL_TIMEOUT_MS)
    // Force-kill: the group plus every escaped descendant that ignored SIGTERM.
    killGroup("SIGKILL")
    killTreePids("SIGKILL")
  }

  function full(file: string) {
    if (process.platform !== "win32") return file
    const shell = Filesystem.windowsPath(file)
    if (path.win32.dirname(shell) !== ".") {
      if (shell.startsWith("/") && name(shell) === "bash") return gitbash() || shell
      return shell
    }
    return Bun.which(shell) || shell
  }

  function pick() {
    const pwsh = Bun.which("pwsh")
    if (pwsh) return pwsh
    const powershell = Bun.which("powershell")
    if (powershell) return powershell
  }

  function select(file: string | undefined, opts?: { acceptable?: boolean }) {
    if (file && (!opts?.acceptable || !BLACKLIST.has(name(file)))) return full(file)
    if (process.platform === "win32") {
      const shell = pick()
      if (shell) return shell
    }
    return fallback()
  }

  export function gitbash() {
    if (process.platform !== "win32") return
    if (Flag.OPENCODE_GIT_BASH_PATH) return Flag.OPENCODE_GIT_BASH_PATH
    const git = which("git")
    if (!git) return
    const file = path.join(git, "..", "..", "bin", "bash.exe")
    if (Filesystem.stat(file)?.size) return file
  }

  function fallback() {
    if (process.platform === "win32") {
      const file = gitbash()
      if (file) return file
      return process.env.COMSPEC || "cmd.exe"
    }
    if (process.platform === "darwin") return "/bin/zsh"
    const bash = which("bash")
    if (bash) return bash
    return "/bin/sh"
  }

  export function name(file: string) {
    if (process.platform === "win32") return path.win32.parse(Filesystem.windowsPath(file)).name.toLowerCase()
    return path.basename(file).toLowerCase()
  }

  export function login(file: string) {
    return LOGIN.has(name(file))
  }

  export function posix(file: string) {
    return POSIX.has(name(file))
  }

  export const preferred = lazy(() => select(process.env.SHELL))

  export const acceptable = lazy(() => select(process.env.SHELL, { acceptable: true }))
}
