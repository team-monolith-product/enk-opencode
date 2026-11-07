import fs from "fs/promises"
import path from "path"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"
import { Assets } from "./assets"

/** Returns false when the path is outside the project, is the project itself, or belongs to `.git`. */
export async function removeProjectPath(input: string): Promise<boolean> {
  const target = path.resolve(Instance.directory, input)
  const relative = path.relative(Instance.directory, target)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false
  if (relative.split(path.sep).some((part) => part.toLowerCase() === ".git")) return false

  // A symlinked folder would pass the string check above and let the delete land outside the project.
  const root = await fs.realpath(Instance.directory)
  const parent = await fs.realpath(path.dirname(target)).catch(() => undefined)
  if (!parent) return true
  if (parent !== root && !Filesystem.contains(root, parent)) return false

  await fs.rm(target, { recursive: true, force: true })
  Assets.invalidate()
  return true
}
