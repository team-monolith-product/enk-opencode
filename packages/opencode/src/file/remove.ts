import fs from "fs/promises"
import path from "path"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { Assets } from "./assets"

export namespace FileRemove {
  export const PROTECTED = [".git", ".opencode"] as const

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

  export async function remove(target: string) {
    await fs.rm(target, { recursive: true, force: true })
    Assets.invalidate()
  }

  export async function clear(): Promise<number> {
    const entries = await fs.readdir(Instance.directory)
    const targets = entries.filter((name) => !isProtected(name))
    for (const name of targets) await fs.rm(path.join(Instance.directory, name), { recursive: true, force: true })
    Assets.invalidate()
    return targets.length
  }
}
