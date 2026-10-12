import { lstat, mkdir, writeFile } from "fs/promises"
import path from "path"
import { Global } from "../global"
import { EnvFile } from "../util/env-file"
import { git } from "../util/git"
import { Hash } from "../util/hash"
import { EnkFailure } from "./failure"

/**
 * 팀 작업 폴더를 커밋하는 단 하나의 저장소. 작업 폴더의 `.git` 은 project id 마커라 진짜 저장소로 쓸 수 없어서,
 * data 디렉토리(EFS)에 따로 둔 저장소가 작업 폴더를 work tree 로 가리킨다. 버전 기록이 여기에 커밋하고,
 * GitHub 올리기는 그 커밋에서 올릴 트리를 만든다.
 */
export namespace WorkspaceRepo {
  export const HEAD = "refs/heads/main"
  const limit = 100 * 1024 * 1024
  const chunk = 200
  const exclude = [
    ".env",
    ".env.*",
    "!.env.example",
    "node_modules/",
    ".next/",
    ".nuxt/",
    ".venv/",
    "__pycache__/",
    ".opencode/",
    ".DS_Store",
  ]

  export type Change = { status: "A" | "M" | "D"; file: string }
  export type Staged = { tree: string; empty: boolean; skipped: string[] }
  type Options = { env?: Record<string, string>; tree?: string }

  const chains = new Map<string, Promise<unknown>>()

  function serial<T>(key: string, fn: () => Promise<T>) {
    const run = (chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn)
    chains.set(key, run)
    return run.finally(() => {
      if (chains.get(key) === run) chains.delete(key)
    })
  }

  export function open(dir: string) {
    const root = path.join(Global.Path.data, "history", Hash.fast(path.resolve(dir)))
    const run = (args: string[], opts?: Options) =>
      git(
        [
          "-c",
          "core.autocrlf=false",
          "-c",
          "core.quotepath=false",
          "--git-dir",
          root,
          "--work-tree",
          opts?.tree ?? dir,
          ...args,
        ],
        { cwd: dir, env: opts?.env, abort: AbortSignal.timeout(120_000) },
      )
    const must = async (args: string[], opts?: Options) => {
      const out = await run(args, opts)
      if (out.exitCode !== 0) throw new EnkFailure("git", 500, out.stderr.toString().trim())
      return out.text()
    }
    /** 작업 폴더와 인덱스를 건드리는 일은 이 줄에 세운다. GitHub 전송처럼 둘을 건드리지 않는 일은 `lane` 을 따로 쓴다. */
    const lock = <T>(fn: () => Promise<T>, lane = "worktree") => serial(`${root}:${lane}`, fn)
    return { dir, root, run, must, lock }
  }
  export type Repo = ReturnType<typeof open>

  export async function ready(repo: Repo) {
    if (!(await Bun.file(path.join(repo.root, "HEAD")).exists())) {
      await mkdir(repo.root, { recursive: true })
      const init = await git(["init", "--quiet", "--bare", repo.root], { cwd: repo.root })
      if (init.exitCode !== 0) throw new EnkFailure("git", 500, init.stderr.toString().trim())
      await git(["--git-dir", repo.root, "config", "core.bare", "false"], { cwd: repo.root })
      await git(["--git-dir", repo.root, "symbolic-ref", "HEAD", HEAD], { cwd: repo.root })
    }
    await mkdir(path.join(repo.root, "info"), { recursive: true })
    await writeFile(path.join(repo.root, "info", "exclude"), exclude.join("\n") + "\n")
  }

  export async function rev(repo: Repo, name: string) {
    const out = await repo.run(["rev-parse", "--verify", "--quiet", name])
    return out.exitCode === 0 ? out.text().trim() : undefined
  }

  export async function each(repo: Repo, args: string[], items: string[], opts?: Options) {
    for (let i = 0; i < items.length; i += chunk) await repo.must([...args, ...items.slice(i, i + chunk)], opts)
  }

  /** 작업 폴더 안에서 따로 `git init` 된 하위 폴더(create-next-app 등)까지 내려가 파일을 모은다. */
  async function scan(repo: Repo, dir = ""): Promise<string[]> {
    const items = (
      await repo.must(["ls-files", "-z", "--others", "--exclude-standard"], {
        tree: path.join(repo.dir, dir),
        env: { GIT_INDEX_FILE: path.join(repo.root, "scan-index") },
      })
    )
      .split("\0")
      .filter(Boolean)
    const nested = await Promise.all(
      items.filter((item) => item.endsWith("/")).map((item) => scan(repo, path.posix.join(dir, item.slice(0, -1)))),
    )
    return [...items.filter((item) => !item.endsWith("/")).map((item) => path.posix.join(dir, item)), ...nested.flat()]
  }

  /**
   * 작업 폴더를 인덱스에 맞춰 트리로 만든다. 인덱스를 저장소에 남겨 두므로 바뀌지 않은 파일은 stat 만 보고
   * 넘어간다. 비밀 파일과 100MB 넘는 파일은 담지 않는다. `lock` 안에서 부른다.
   */
  export async function stage(repo: Repo): Promise<Staged> {
    await ready(repo)
    const sized = await Promise.all(
      (await scan(repo))
        .filter((file) => !EnvFile.isSecretFile(file))
        .map(async (file) => ({ file, size: (await lstat(path.join(repo.dir, file)).catch(() => undefined))?.size })),
    )
    const keep = sized.filter((item) => item.size !== undefined && item.size <= limit).map((item) => item.file)
    const wanted = new Set(keep)
    const gone = (await repo.must(["ls-files", "-z"]))
      .split("\0")
      .filter(Boolean)
      .filter((file) => !wanted.has(file))
    await each(repo, ["update-index", "--force-remove", "--"], gone)
    await each(repo, ["update-index", "--add", "--replace", "--"], keep)
    return {
      tree: (await repo.must(["write-tree"])).trim(),
      empty: keep.length === 0,
      skipped: sized.filter((item) => (item.size ?? 0) > limit).map((item) => item.file),
    }
  }

  export async function diff(repo: Repo, from: string | undefined, to: string): Promise<Change[]> {
    if (!from) {
      const files = (await repo.must(["ls-tree", "-r", "-z", "--name-only", to])).split("\0").filter(Boolean)
      return files.map((file) => ({ status: "A", file }))
    }
    const out = (await repo.must(["diff-tree", "-r", "-z", "--no-renames", "--name-status", from, to]))
      .split("\0")
      .filter(Boolean)
    const list: Change[] = []
    for (let i = 0; i + 1 < out.length; i += 2) {
      const status = out[i]
      list.push({ status: status === "A" || status === "D" ? status : "M", file: out[i + 1]! })
    }
    return list
  }
}
