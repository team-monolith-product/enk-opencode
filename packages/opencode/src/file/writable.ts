import fs from "fs/promises"
import path from "path"
import { Instance } from "../project/instance"
import { EnvFile } from "../util/env-file"
import { Filesystem } from "../util/filesystem"

// PUT /file/content 와 AI 이미지 편집 도구(image_edit)가 같은 기준으로 "덮어써도 되는 파일"을 고른다.
export namespace Writable {
  const tails = new Map<string, Promise<unknown>>()

  /**
   * 같은 실제 경로에 대한 fn 들을 한 번에 하나씩 돌린다. 저장의 "확인 → 교체" 와 AI 편집의 잠금 잡기가
   * 서로 끼어들지 못하게 해, 확인을 통과한 뒤 다른 쪽이 파일을 바꿔 그 변경을 덮어쓰는 일을 막는다.
   */
  export async function exclusive<T>(real: string, fn: () => Promise<T>): Promise<T> {
    const previous = tails.get(real) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(fn)
    const tail = run.catch(() => {})
    tails.set(real, tail)
    try {
      return await run
    } finally {
      if (tails.get(real) === tail) tails.delete(real)
    }
  }

  /**
   * The file `requested` names, if the write route may replace it: an existing regular file whose
   * real location (symlinks followed) is inside the project, outside `.git`, and not a secret env file.
   * The client controls `requested`, so every one of those checks is needed — a lexical check alone
   * lets a symlink in the project point the write at any file the server can reach.
   */
  export async function file(requested: string) {
    const full = path.resolve(Instance.directory, requested)
    if (!Instance.containsPath(full)) return
    if (EnvFile.isSecretFile(full)) return

    const stat = await fs.stat(full).catch(() => undefined)
    if (!stat?.isFile()) return

    const real = await fs.realpath(full)
    const roots = [Instance.directory, ...(Instance.worktree === "/" ? [] : [Instance.worktree])]
    const realRoots = await Promise.all(roots.map((root) => fs.realpath(root).catch(() => root)))
    const root = realRoots.find((item) => Filesystem.contains(item, real))
    if (!root) return
    const relative = path.relative(root, real)
    if (relative.split(path.sep).includes(".git")) return
    if (EnvFile.isSecretFile(real)) return

    return {
      real,
      relative: path.relative(Instance.directory, full).split(path.sep).join("/"),
      mode: stat.mode & 0o777,
    }
  }
}
