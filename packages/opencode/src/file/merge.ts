import { mkdtemp, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { git } from "../util/git"
import type { SessionID } from "../session/schema"
import { FileTime } from "./time"

export namespace FileMerge {
  export const NOTE =
    "This file was changed by someone else (another chat or a teammate) after you last read it. Your change was applied on top of their changes, so the file now contains both. Read it again before editing it further."

  export function conflict(filepath: string) {
    return new Error(
      `File ${filepath} was changed by someone else (another chat or a teammate) after you last read it, and their changes overlap with yours, so nothing was written. Read the file again and redo your change on top of the current content, keeping their changes.`,
    )
  }

  export async function resolve(sessionID: SessionID, filepath: string, current: string, ours: string) {
    const seen = await FileTime.check(sessionID, filepath)
    if (seen.status === "fresh") return ours
    if (seen.status === "unread" || seen.base === undefined) {
      await FileTime.assert(sessionID, filepath)
      return ours
    }
    const result = await three({ base: seen.base, current, ours })
    if (!result.clean) throw conflict(filepath)
    return result.content
  }

  export type Result = { clean: true; content: string } | { clean: false; conflicts: number }

  export async function three(input: { base: string; current: string; ours: string }): Promise<Result> {
    if (input.current === input.base) return { clean: true, content: input.ours }
    if (input.ours === input.base || input.ours === input.current) return { clean: true, content: input.current }
    const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-merge-"))
    try {
      const ours = path.join(dir, "ours")
      const base = path.join(dir, "base")
      const theirs = path.join(dir, "theirs")
      await Promise.all([
        writeFile(ours, input.ours, "utf-8"),
        writeFile(base, input.base, "utf-8"),
        writeFile(theirs, input.current, "utf-8"),
      ])
      const out = await git(["merge-file", "-p", ours, base, theirs], { cwd: dir })
      if (out.exitCode === 0) return { clean: true, content: out.stdout.toString("utf-8") }
      if (out.exitCode > 0 && out.exitCode < 128 && out.stdout.toString("utf-8").includes("<<<<<<<"))
        return { clean: false, conflicts: out.exitCode }
      throw new Error(`git merge-file failed: ${out.stderr.toString().trim()}`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}
