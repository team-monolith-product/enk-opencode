import { lstat, mkdir, writeFile } from "fs/promises"
import path from "path"
import { Global } from "../global"
import { EnvFile } from "../util/env-file"
import { git } from "../util/git"
import { Hash } from "../util/hash"
import { Log } from "../util/log"
import { GitHub } from "./github"
import { ServeTargets } from "./serve-targets"

/**
 * 팀 작업 폴더의 버전 기록. 작업 폴더의 `.git` 은 project id 마커라 진짜 저장소로 쓸 수 없어서,
 * data 디렉토리(EFS)에 따로 둔 저장소가 작업 폴더를 work tree 로 가리킨다.
 *
 * 되돌리기는 기록을 지우지 않는다. 고른 시점의 트리로 작업 폴더를 맞춘 뒤 그 트리를 새 커밋으로
 * 앞에 쌓으므로, 되돌린 것도 다시 되돌릴 수 있다.
 */
export namespace History {
  const log = Log.create({ service: "history" })
  const ref = "refs/heads/main"
  const limit = 100 * 1024 * 1024
  const chunk = 200
  const who = {
    GIT_AUTHOR_NAME: "Jitda",
    GIT_AUTHOR_EMAIL: "jitda@users.noreply.github.com",
    GIT_COMMITTER_NAME: "Jitda",
    GIT_COMMITTER_EMAIL: "jitda@users.noreply.github.com",
  }
  const manifests = new Set([
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "requirements.txt",
    "pyproject.toml",
    "uv.lock",
  ])

  export const Trailer = { message: "Jitda-Message", revert: "Jitda-Revert-Of" } as const

  export type Change = GitHub.Change
  export type Entry = { sha: string; time: number; subject: string; revert?: string }
  export type Saved = { sha: string; message: string; changes: Change[] }
  export type Restored = { sha: string; target: Entry; changes: Change[]; deps: boolean }
  export type Code = "disabled" | "closed" | "missing" | "git"

  export class Failure extends Error {
    constructor(
      readonly code: Code,
      readonly status: 403 | 404 | 500,
      message?: string,
    ) {
      super(message || code)
      this.name = "HistoryFailure"
    }
  }

  const chains = new Map<string, Promise<unknown>>()

  function serial<T>(key: string, fn: () => Promise<T>) {
    const run = (chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn)
    chains.set(key, run)
    return run.finally(() => {
      if (chains.get(key) === run) chains.delete(key)
    })
  }

  /** 본행사 작업 폴더만 기록한다. 튜토리얼 폴더는 연습용이라 되돌릴 일이 없다. */
  export function enabled(dir: string) {
    const target = ServeTargets.project()
    if (!target) return true
    return path.resolve(dir) === target.dir
  }

  /** 되돌리기는 본행사가 진행 중일 때만 연다. 마감 뒤 결과물은 갤러리에 공개된 그대로 둔다. */
  export async function open() {
    const url = process.env["ENK_HACKATHON_RAILS_URL"]
    const token = process.env["ENK_AI_USAGE_TOKEN"]
    if (!url || !token) return true
    const res = await fetch(url.replace(/\/+$/, "") + "/api/v1/opencode/hackathon", {
      headers: { Authorization: `token ${token}` },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined)
    if (!res?.ok) return false
    const body = (await res.json().catch(() => undefined)) as { status?: string } | undefined
    return body?.status === "hackathon_running"
  }

  export function gitdir(dir: string) {
    return path.join(Global.Path.data, "history", Hash.fast(path.resolve(dir)))
  }

  function repo(dir: string) {
    const root = gitdir(dir)
    const run = (args: string[], opts?: { env?: Record<string, string>; tree?: string }) =>
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
    const must = async (args: string[], opts?: { env?: Record<string, string>; tree?: string }) => {
      const out = await run(args, opts)
      if (out.exitCode !== 0) throw new Failure("git", 500, out.stderr.toString().trim())
      return out.text()
    }
    return { dir, root, run, must }
  }
  type Repo = ReturnType<typeof repo>

  async function ready(repo: Repo) {
    if (!(await Bun.file(path.join(repo.root, "HEAD")).exists())) {
      await mkdir(repo.root, { recursive: true })
      const init = await git(["init", "--quiet", "--bare", repo.root], { cwd: repo.root })
      if (init.exitCode !== 0) throw new Failure("git", 500, init.stderr.toString().trim())
      await git(["--git-dir", repo.root, "config", "core.bare", "false"], { cwd: repo.root })
      await git(["--git-dir", repo.root, "symbolic-ref", "HEAD", ref], { cwd: repo.root })
    }
    await mkdir(path.join(repo.root, "info"), { recursive: true })
    await writeFile(path.join(repo.root, "info", "exclude"), GitHub.exclude.join("\n") + "\n")
  }

  async function head(repo: Repo) {
    const out = await repo.run(["rev-parse", "--verify", "--quiet", ref])
    return out.exitCode === 0 ? out.text().trim() : undefined
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

  /** 인덱스를 저장소에 남겨 두므로 바뀌지 않은 파일은 stat 만 보고 넘어간다. */
  async function stage(repo: Repo) {
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
    for (let i = 0; i < gone.length; i += chunk) {
      await repo.must(["update-index", "--force-remove", "--", ...gone.slice(i, i + chunk)])
    }
    for (let i = 0; i < keep.length; i += chunk) {
      await repo.must(["update-index", "--add", "--replace", "--", ...keep.slice(i, i + chunk)])
    }
    return (await repo.must(["write-tree"])).trim()
  }

  async function tree(repo: Repo, rev: string) {
    return (await repo.must(["rev-parse", `${rev}^{tree}`])).trim()
  }

  async function diff(repo: Repo, from: string | undefined, to: string): Promise<Change[]> {
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

  function compose(subject: string, trailers: Record<string, string | undefined>) {
    const lines = Object.entries(trailers).flatMap(([key, value]) => (value ? [`${key}: ${value}`] : []))
    return lines.length ? `${subject}\n\n${lines.join("\n")}` : subject
  }

  async function save(
    repo: Repo,
    input: {
      message: string | ((changes: Change[]) => Promise<string>)
      trailers?: Record<string, string | undefined>
    },
  ): Promise<Saved | undefined> {
    await ready(repo)
    const staged = await stage(repo)
    const parent = await head(repo)
    if (parent && staged === (await tree(repo, parent))) return
    const changes = await diff(repo, parent ? `${parent}^{tree}` : undefined, staged)
    const message = typeof input.message === "string" ? input.message : await input.message(changes)
    const sha = (
      await repo.must(
        [
          "commit-tree",
          "--no-gpg-sign",
          staged,
          ...(parent ? ["-p", parent] : []),
          "-m",
          compose(message, input.trailers ?? {}),
        ],
        { env: who },
      )
    ).trim()
    await repo.must(["update-ref", ref, sha, parent ?? ""])
    return { sha, message, changes }
  }

  export async function commit(
    dir: string,
    input: {
      message: string | ((changes: Change[]) => Promise<string>)
      trailers?: Record<string, string | undefined>
    },
  ) {
    if (!enabled(dir)) return
    const target = repo(dir)
    const saved = await serial(target.root, () => save(target, input))
    if (saved) log.info("saved", { sha: saved.sha, files: saved.changes.length })
    return saved
  }

  export async function list(dir: string, max = 200): Promise<Entry[]> {
    if (!enabled(dir)) return []
    const target = repo(dir)
    if (!(await Bun.file(path.join(target.root, "HEAD")).exists())) return []
    if (!(await head(target))) return []
    const format = `%H%x1f%ct%x1f%s%x1f%(trailers:key=${Trailer.revert},valueonly,separator=)%x1e`
    const out = await target.must(["log", `-n${max}`, `--format=${format}`, ref])
    return out
      .split("\x1e")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [sha, time, subject, revert] = line.split("\x1f")
        return { sha: sha!, time: Number(time) * 1000, subject: subject ?? "", revert: revert?.trim() || undefined }
      })
  }

  /** 직전 답변 뒤에 되돌렸다면, 앞선 대화가 말하는 파일과 지금 파일이 다르다는 걸 AI 에게 알린다. */
  export async function reminder(dir: string, since: number) {
    const floor = Math.floor(since / 1000) * 1000
    const found = (await list(dir, 20).catch(() => [])).find((entry) => entry.revert && entry.time >= floor)
    if (!found) return
    return [
      "<system-reminder>",
      `After your last reply the team rolled the project files back to an earlier saved version (${JSON.stringify(found.subject)}).`,
      "Files may no longer match what earlier messages in this conversation describe. Re-read a file before you edit it, and do not redo the rolled-back changes unless the user asks for them.",
      "</system-reminder>",
    ].join("\n")
  }

  async function reachable(repo: Repo, sha: string) {
    if (!/^[0-9a-f]{40}$/.test(sha)) return false
    const found = await repo.run(["cat-file", "-e", `${sha}^{commit}`])
    if (found.exitCode !== 0) return false
    return (await repo.run(["merge-base", "--is-ancestor", sha, ref])).exitCode === 0
  }

  async function describe(repo: Repo, sha: string): Promise<Entry> {
    const [time, subject] = (await repo.must(["log", "-1", "--format=%ct%x1f%s", sha])).trim().split("\x1f")
    return { sha, time: Number(time) * 1000, subject: subject ?? "" }
  }

  /** 기록에 있는 시점이면 그 시점을, 아니면 undefined. */
  export async function entry(dir: string, sha: string) {
    if (!enabled(dir)) return
    const target = repo(dir)
    if (!(await reachable(target, sha))) return
    return describe(target, sha)
  }

  /** 그 시점에 무엇이 바뀌었는지(직전 기록과 비교). */
  export async function changes(dir: string, sha: string) {
    if (!enabled(dir)) throw new Failure("disabled", 404)
    const target = repo(dir)
    if (!(await reachable(target, sha))) throw new Failure("missing", 404)
    const parent = await target.run(["rev-parse", "--verify", "--quiet", `${sha}^`])
    return diff(target, parent.exitCode === 0 ? `${parent.text().trim()}^{tree}` : undefined, `${sha}^{tree}`)
  }

  /**
   * 작업 폴더를 `sha` 시점으로 맞춘다. 마지막 기록 뒤에 바뀐 파일(업로드·직접 편집)이 있으면 먼저
   * 기록해 두고, 기록에서 빠진 파일(.env·node_modules·큰 파일)은 건드리지 않는다.
   */
  export async function restore(
    dir: string,
    input: { sha: string; message: (target: Entry) => string; backup: string },
  ): Promise<Restored> {
    if (!enabled(dir)) throw new Failure("disabled", 404)
    const target = repo(dir)
    return serial(target.root, async () => {
      await ready(target)
      if (!(await reachable(target, input.sha))) throw new Failure("missing", 404)
      await save(target, { message: input.backup })
      const parent = (await head(target))!
      const goal = await tree(target, input.sha)
      const changes = await diff(target, `${parent}^{tree}`, goal)
      const entry = await describe(target, input.sha)
      if (changes.length === 0) return { sha: parent, target: entry, changes, deps: false }
      await target.must(["read-tree", "--reset", "-u", goal])
      const sha = (
        await target.must(
          [
            "commit-tree",
            "--no-gpg-sign",
            goal,
            "-p",
            parent,
            "-m",
            compose(input.message(entry), { [Trailer.revert]: input.sha }),
          ],
          { env: who },
        )
      ).trim()
      await target.must(["update-ref", ref, sha, parent])
      log.info("restored", { sha, target: input.sha, files: changes.length })
      return {
        sha,
        target: entry,
        changes,
        deps: changes.some((change) => manifests.has(path.posix.basename(change.file))),
      }
    })
  }
}
