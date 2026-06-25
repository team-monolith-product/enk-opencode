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

    // Group is empty when signal 0 throws ESRCH; truthy means something survives.
    const groupAlive = () => {
      try {
        process.kill(-pid, 0)
        return true
      } catch {
        return false
      }
    }

    killGroup("SIGTERM")
    // Skip the SIGKILL grace only when the parent reported exit AND the group is
    // empty — i.e. the whole tree is already gone.
    if (opts?.exited?.() && !groupAlive()) return
    await sleep(SIGKILL_TIMEOUT_MS)
    // Always SIGKILL the group: opts.exited only reflects the parent, so a child
    // that ignored SIGTERM is still here even when the parent has exited.
    killGroup("SIGKILL")
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
