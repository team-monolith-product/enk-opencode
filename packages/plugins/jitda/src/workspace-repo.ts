import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Env } from "./env"
import { EnkFailure } from "./failure"

// 팀 작업 폴더를 커밋하는 단 하나의 저장소. 작업 폴더의 .git 은 project id 마커라 진짜 저장소로 쓸 수 없어서 데이터 디렉터리에
// 따로 둔 저장소가 작업 폴더를 work tree 로 가리킨다. 버전 기록이 여기에 커밋하고 GitHub 올리기는 그 커밋에서 트리를 만든다.

export const HEAD = "refs/heads/main"
const LIMIT = 100 * 1024 * 1024
const CHUNK = 200
// 에이전트가 작업 폴더에 남기는 부산물 폴더. 학생 .gitignore 의 ! 패턴이 info/exclude 보다 앞서므로 경로로도 거른다.
export const IGNORED = [".playwright-mcp/"]
const LEFTOVERS = IGNORED.map((item) => item.replace(/\/$/, ""))
const EXCLUDE = [
  ".env",
  ".env.*",
  "!.env.example",
  "node_modules/",
  ".next/",
  ".nuxt/",
  ".venv/",
  "__pycache__/",
  ".opencode/",
  ...IGNORED,
  ".DS_Store",
  "__preview-bridge.js",
  ".nfs*",
]

export type Change = { status: "A" | "M" | "D"; file: string }
export type Staged = { tree: string; empty: boolean; skipped: string[] }
type Options = { env?: Record<string, string>; tree?: string }
type Run = { exitCode: number; stdout: string; stderr: string }

// 에이전트가 남기는 부산물 폴더를 작업 폴더의 .gitignore 에 적어 둔다. 이미 있으면 건드리지 않는다.
export async function ignore(dir: string) {
  const file = path.join(dir, ".gitignore")
  const text = await readFile(file, "utf8").catch(() => "")
  const lines = new Set(text.split(/\r?\n/).map((line) => line.trim().replace(/\/$/, "")))
  const missing = IGNORED.filter((item) => !lines.has(item.replace(/\/$/, "")))
  if (missing.length === 0) return
  await writeFile(file, text + (text && !text.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n")
}

function git(args: string[], options: { cwd: string; env?: Record<string, string> }): Promise<Run> {
  return new Promise((done) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: { ...Env.sanitize(), ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.on("error", (error) => done({ exitCode: 1, stdout: "", stderr: String(error) }))
    child.on("close", (code) =>
      done({ exitCode: code ?? 1, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }),
    )
  })
}

const chains = new Map<string, Promise<unknown>>()

function serial<T>(key: string, fn: () => Promise<T>) {
  const run = (chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn)
  chains.set(key, run)
  return run.finally(() => {
    if (chains.get(key) === run) chains.delete(key)
  })
}

function dataDir(env: NodeJS.ProcessEnv = process.env) {
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode")
}

export function open(dir: string) {
  // 경로 이름은 버전 기록 저장소로 처음 만들 때 그대로 둔다. 이미 쌓인 기록을 잇는다.
  const root = path.join(dataDir(), "history", createHash("sha1").update(path.resolve(dir)).digest("hex"))
  const run = (args: string[], options?: Options) =>
    git(
      [
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.quotepath=false",
        "--git-dir",
        root,
        "--work-tree",
        options?.tree ?? dir,
        ...args,
      ],
      { cwd: dir, env: options?.env },
    )
  const must = async (args: string[], options?: Options) => {
    const out = await run(args, options)
    if (out.exitCode !== 0) throw new EnkFailure("git", 500, out.stderr.trim())
    return out.stdout
  }
  // 작업 폴더와 인덱스를 건드리는 일은 이 줄에 세운다. GitHub 전송처럼 둘을 건드리지 않는 일은 lane 을 따로 쓴다.
  const lock = <T>(fn: () => Promise<T>, lane = "worktree") => serial(`${root}:${lane}`, fn)
  return { dir, root, run, must, lock }
}
export type Repo = ReturnType<typeof open>

export async function ready(repo: Repo) {
  if (!existsSync(path.join(repo.root, "HEAD"))) {
    await mkdir(repo.root, { recursive: true })
    const init = await git(["init", "--quiet", "--bare", repo.root], { cwd: repo.root })
    if (init.exitCode !== 0) throw new EnkFailure("git", 500, init.stderr.trim())
    await git(["--git-dir", repo.root, "config", "core.bare", "false"], { cwd: repo.root })
    await git(["--git-dir", repo.root, "symbolic-ref", "HEAD", HEAD], { cwd: repo.root })
  }
  await mkdir(path.join(repo.root, "info"), { recursive: true })
  await writeFile(path.join(repo.root, "info", "exclude"), EXCLUDE.join("\n") + "\n")
}

export async function rev(repo: Repo, name: string) {
  const out = await repo.run(["rev-parse", "--verify", "--quiet", name])
  return out.exitCode === 0 ? out.stdout.trim() : undefined
}

export async function each(repo: Repo, args: string[], items: string[], options?: Options) {
  for (let i = 0; i < items.length; i += CHUNK) await repo.must([...args, ...items.slice(i, i + CHUNK)], options)
}

// 작업 폴더 안에서 따로 git init 된 하위 폴더(create-next-app 등)까지 내려가 파일을 모은다.
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

const leftover = (file: string) => file.split("/").some((part) => LEFTOVERS.includes(part))

// 작업 폴더를 인덱스에 맞춰 트리로 만든다. 인덱스를 저장소에 남겨 두므로 바뀌지 않은 파일은 stat 만 보고 넘어간다.
// 비밀 파일과 100MB 넘는 파일은 담지 않는다. lock 안에서 부른다.
export async function stage(repo: Repo): Promise<Staged> {
  await ready(repo)
  const sized = await Promise.all(
    (await scan(repo))
      .filter((file) => !Env.isSecretFile(file) && !leftover(file))
      .map(async (file) => ({ file, size: (await lstat(path.join(repo.dir, file)).catch(() => undefined))?.size })),
  )
  const keep = sized.filter((item) => item.size !== undefined && item.size <= LIMIT).map((item) => item.file)
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
    skipped: sized.filter((item) => (item.size ?? 0) > LIMIT).map((item) => item.file),
  }
}

// 기록에 담지 않는 파일(크기 초과로 디스크에만 있는 파일, 제외 규칙·비밀 파일). 되돌리기가 이 경로는 건드리지 않는다.
export async function unrecorded(repo: Repo, files: string[]) {
  const ignored = new Set<string>()
  for (let i = 0; i < files.length; i += CHUNK) {
    const out = await repo.run(["check-ignore", "--no-index", "--", ...files.slice(i, i + CHUNK)])
    for (const line of out.stdout.split("\n")) if (line) ignored.add(line)
  }
  const flags = await Promise.all(
    files.map(
      async (file) =>
        ignored.has(file) ||
        Env.isSecretFile(file) ||
        leftover(file) ||
        (await lstat(path.join(repo.dir, file)).then(
          () => true,
          () => false,
        )),
    ),
  )
  return files.filter((_, i) => flags[i])
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

export * as WorkspaceRepo from "./workspace-repo"
