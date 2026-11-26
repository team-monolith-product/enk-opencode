import fs from "fs/promises"
import path from "path"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { DevServerReplay } from "../enk/dev-server-replay"
import { History } from "../enk/history"
import { Assets } from "./assets"

export namespace FileRemove {
  export const PROTECTED = [".git"] as const

  function isProtected(segment: string) {
    return (PROTECTED as readonly string[]).includes(segment)
  }

  export async function resolve(input: string): Promise<string | undefined> {
    const parts = input.split(/[/\\]/).filter((part) => part !== "" && part !== ".")
    if (parts.length === 0) return undefined
    if (parts.includes("..")) return undefined
    if (parts.some(isProtected)) return undefined

    const base = Instance.directory
    const target = path.resolve(base, ...parts)
    if (target === base) return undefined
    if (!Filesystem.contains(base, target)) return undefined

    const parent = await fs.realpath(path.dirname(target)).catch(() => undefined)
    const root = await fs.realpath(base).catch(() => undefined)
    if (!parent || !root) return undefined
    if (parent !== root && !Filesystem.contains(root, parent)) return undefined
    return target
  }

  async function snapshot() {
    await History.commit(Instance.directory, { message: "파일 삭제 전 자동 저장" })
  }

  const RETRY = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const

  export async function remove(target: string) {
    await snapshot()
    await fs.rm(target, RETRY)
    Assets.invalidate()
  }

  async function stopDevServer() {
    const record = await DevServerReplay.loadRecord(Instance.directory)
    if (record) await DevServerReplay.stop(record.port, record.pid).catch(() => false)
  }

  async function sweep(): Promise<number> {
    const entries = await fs.readdir(Instance.directory)
    const targets = entries.filter((name) => !isProtected(name))
    for (const name of targets) await fs.rm(path.join(Instance.directory, name), RETRY).catch(() => undefined)
    return targets.length
  }

  export async function clear(): Promise<number> {
    await snapshot()
    await stopDevServer()
    const removed = await sweep()
    // A process that still held a file open leaves an .nfs* placeholder behind; once the first pass has let go of it, a second pass can take it.
    await sweep()
    Assets.invalidate()
    return removed
  }
}
