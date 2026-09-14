import { mkdir, lstat, readFile, writeFile } from "fs/promises"
import path from "path"
import { Global } from "../global"
import { EnvFile } from "../util/env-file"
import { git } from "../util/git"
import { Hash } from "../util/hash"
import { Log } from "../util/log"
import { ServeTargets } from "./serve-targets"

export namespace GitHub {
  const log = Log.create({ service: "github" })
  const web = "https://github.com"
  const api = "https://api.github.com"
  const agent = "jitda-opencode"
  const route = "/api/v1/opencode/github"
  const limit = 100 * 1024 * 1024
  const bridge = "__preview-bridge.js"
  const tag = /[ \t]*<script\b[^>]*\bdata-preview-bridge\b[^>]*>\s*<\/script>[ \t]*(\r?\n)?/gi
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

  export type Repo = { owner: string; name: string; url: string; private?: boolean }
  export type Push = { sha: string; time: number; by?: string }
  export type Status = {
    enabled: boolean
    connectUrl?: string
    login?: string
    linkedBy?: string
    repo?: Repo
    push?: Push
  }
  export type Result = { sha?: string; skipped: string[] }
  export type Change = { status: "A" | "M" | "D"; file: string }
  export type Describe = (changes: Change[]) => Promise<string>
  export type Code =
    | "disabled"
    | "unlinked"
    | "norepo"
    | "exists"
    | "forbidden"
    | "revoked"
    | "missing"
    | "empty"
    | "remote"

  type Link = {
    enabled: boolean
    connected: boolean
    connect_url?: string
    login?: string
    github_user_id?: number
    linked_by?: string
    token?: string
    repo?: { owner: string; name: string; url: string }
    push?: { sha: string; at: number; by?: string }
  }
  type Remote = {
    name: string
    owner: { login: string }
    html_url: string
    default_branch?: string
    private: boolean
    permissions?: { push?: boolean }
  }

  export class Failure extends Error {
    constructor(
      readonly code: Code,
      readonly status: 404 | 409 | 422 | 502,
      message?: string,
    ) {
      super(message || code)
      this.name = "GitHubFailure"
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

  /** 본행사 작업 폴더에서만 연다. 튜토리얼 폴더를 같은 저장소로 올리면 결과물을 덮어쓴다. */
  function serves(dir: string) {
    const target = ServeTargets.project()
    if (!target) return true
    return path.resolve(dir) === target.dir
  }

  function backend() {
    const url = process.env["ENK_HACKATHON_RAILS_URL"]
    const token = process.env["ENK_AI_USAGE_TOKEN"]
    if (!url || !token) return
    return { url: url.replace(/\/+$/, "") + route, token }
  }

  async function link(): Promise<Link | undefined> {
    const rails = backend()
    if (!rails) return
    const res = await fetch(rails.url, {
      headers: { Authorization: `token ${rails.token}` },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined)
    if (!res?.ok) return
    return (await res.json().catch(() => undefined)) as Link | undefined
  }

  async function report(body: Record<string, string | boolean | null>) {
    const rails = backend()
    if (!rails) return
    const res = await fetch(rails.url, {
      method: "PUT",
      headers: { Authorization: `token ${rails.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined)
    if (!res?.ok) throw new Failure("remote", 502)
  }

  async function linked() {
    const hit = await link()
    if (!hit?.connected || !hit.token) throw new Failure("unlinked", 409)
    return hit
  }

  export async function status(dir: string): Promise<Status> {
    if (!serves(dir)) return { enabled: false }
    const hit = await link()
    if (!hit?.enabled) return { enabled: false }
    return {
      enabled: true,
      connectUrl: hit.connect_url,
      login: hit.connected ? hit.login : undefined,
      linkedBy: hit.connected ? hit.linked_by : undefined,
      repo: hit.repo,
      push: hit.push ? { sha: hit.push.sha, time: hit.push.at, by: hit.push.by } : undefined,
    }
  }

  async function request<T>(token: string, method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(api + url, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": agent,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    }).catch((err) => {
      throw new Failure("remote", 502, String(err))
    })
    if (res.ok) return (await res.json()) as T
    const detail = (await res.json().catch(() => undefined)) as
      | { message?: string; errors?: { message?: string }[] }
      | undefined
    const message = detail?.errors?.[0]?.message || detail?.message || res.statusText
    if (res.status === 401) {
      await report({ revoked: true }).catch(() => undefined)
      throw new Failure("revoked", 409, message)
    }
    if (res.status === 404) throw new Failure("missing", 404, message)
    if (res.status === 422) throw new Failure("exists", 422, message)
    throw new Failure("remote", 502, message)
  }

  const shape = (remote: Remote): Repo => ({
    owner: remote.owner.login,
    name: remote.name,
    url: remote.html_url,
    private: remote.private,
  })

  export async function create(dir: string, input: { name: string }) {
    const hit = await linked()
    const repo = shape(
      await request<Remote>(hit.token!, "POST", "/user/repos", { name: input.name, private: false, auto_init: false }),
    )
    await report({ repo_owner: repo.owner, repo_name: repo.name, repo_url: repo.url })
    return status(dir)
  }

  function auth(token: string) {
    return {
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: `http.${web}/.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
    }
  }

  export async function push(dir: string, input: { message: string | Describe }) {
    const hit = await linked()
    if (!hit.repo) throw new Failure("norepo", 409)
    const remote = await request<Remote>(
      hit.token!,
      "GET",
      `/repos/${encodeURIComponent(hit.repo.owner)}/${encodeURIComponent(hit.repo.name)}`,
    )
    if (remote.permissions?.push === false) throw new Failure("forbidden", 409)
    const gitdir = path.join(Global.Path.data, "github", Hash.fast(dir))
    const result = await serial(gitdir, () =>
      publish({
        gitdir,
        worktree: dir,
        remote: `${web}/${hit.repo!.owner}/${hit.repo!.name}.git`,
        branch: remote.default_branch || "main",
        message: input.message,
        author: {
          name: hit.login || "Jitda",
          email: `${hit.github_user_id ? `${hit.github_user_id}+` : ""}${hit.login}@users.noreply.github.com`,
        },
        env: auth(hit.token!),
      }),
    )
    if (result.sha) {
      await report({ pushed_sha: result.sha, pushed_by: null }).catch(() => undefined)
      log.info("pushed", { sha: result.sha })
    }
    return { ...result, url: result.sha ? `${hit.repo.url}/commit/${result.sha}` : hit.repo.url }
  }

  export async function publish(input: {
    gitdir: string
    worktree: string
    remote: string
    branch: string
    message: string | Describe
    author: { name: string; email: string }
    env?: Record<string, string>
  }): Promise<Result> {
    const run = (args: string[], opts?: { env?: Record<string, string>; tree?: string }) =>
      git(
        [
          "-c",
          "core.autocrlf=false",
          "-c",
          "core.quotepath=false",
          "--git-dir",
          input.gitdir,
          "--work-tree",
          opts?.tree ?? input.worktree,
          ...args,
        ],
        { cwd: input.worktree, env: { ...input.env, ...opts?.env }, abort: AbortSignal.timeout(120_000) },
      )
    const must = async (args: string[], opts?: { env?: Record<string, string>; tree?: string }) => {
      const out = await run(args, opts)
      if (out.exitCode !== 0) throw new Failure("remote", 502, out.stderr.toString().trim())
      return out.text()
    }

    if (!(await Bun.file(path.join(input.gitdir, "HEAD")).exists())) {
      await mkdir(input.gitdir, { recursive: true })
      const init = await git(["init", "--quiet", "--bare", input.gitdir], { cwd: input.gitdir })
      if (init.exitCode !== 0) throw new Failure("remote", 502, init.stderr.toString().trim())
    }
    await mkdir(path.join(input.gitdir, "info"), { recursive: true })
    await writeFile(path.join(input.gitdir, "info", "exclude"), exclude.join("\n") + "\n")

    const ref = `refs/heads/${input.branch}`
    const track = `refs/remotes/jitda/${input.branch}`
    const who = {
      GIT_AUTHOR_NAME: input.author.name,
      GIT_AUTHOR_EMAIL: input.author.email,
      GIT_COMMITTER_NAME: input.author.name,
      GIT_COMMITTER_EMAIL: input.author.email,
    }

    const scan = async (dir: string): Promise<string[]> => {
      const items = (
        await must(["ls-files", "-z", "--others", "--exclude-standard"], { tree: path.join(input.worktree, dir) })
      )
        .split("\0")
        .filter(Boolean)
      const nested = await Promise.all(
        items.filter((item) => item.endsWith("/")).map((item) => scan(path.posix.join(dir, item.slice(0, -1)))),
      )
      return [
        ...items.filter((item) => !item.endsWith("/")).map((item) => path.posix.join(dir, item)),
        ...nested.flat(),
      ]
    }

    const stage = async () => {
      await must(["read-tree", "--empty"])
      const files = await Promise.all(
        (await scan(""))
          .filter((file) => !EnvFile.isSecretFile(file) && path.posix.basename(file) !== bridge)
          .map(async (file) => ({
            file,
            size: (await lstat(path.join(input.worktree, file)).catch(() => undefined))?.size,
          })),
      )
      const keep = files.filter((item) => item.size !== undefined && item.size <= limit).map((item) => item.file)
      if (keep.length === 0) throw new Failure("empty", 422)
      const stripped = (
        await Promise.all(
          keep
            .filter((file) => /\.html?$/i.test(file))
            .map(async (file) => {
              const text = await readFile(path.join(input.worktree, file), "utf8").catch(() => "")
              const clean = text.replace(tag, "")
              return clean === text ? undefined : { file, clean }
            }),
        )
      ).filter((item) => item !== undefined)
      const dirty = new Set(stripped.map((item) => item.file))
      const plain = keep.filter((file) => !dirty.has(file))
      for (let i = 0; i < plain.length; i += 200) {
        await must(["update-index", "--add", "--remove", "--", ...plain.slice(i, i + 200)])
      }
      for (const item of stripped) {
        const tmp = path.join(input.gitdir, "stripped")
        await writeFile(tmp, item.clean)
        const blob = (await must(["hash-object", "-w", "--no-filters", "--", tmp])).trim()
        await must(["update-index", "--add", "--cacheinfo", `100644,${blob},${item.file}`])
      }
      return {
        tree: (await must(["write-tree"])).trim(),
        skipped: files.filter((item) => (item.size ?? 0) > limit).map((item) => item.file),
      }
    }

    const changes = async (parent: string | undefined, tree: string): Promise<Change[]> => {
      if (!parent) {
        const files = (await must(["ls-tree", "-r", "-z", "--name-only", tree])).split("\0").filter(Boolean)
        return files.map((file) => ({ status: "A", file }))
      }
      const out = (await must(["diff-tree", "-r", "-z", "--no-renames", "--name-status", `${parent}^{tree}`, tree]))
        .split("\0")
        .filter(Boolean)
      const list: Change[] = []
      for (let i = 0; i + 1 < out.length; i += 2) {
        const status = out[i]
        list.push({ status: status === "A" || status === "D" ? status : "M", file: out[i + 1]! })
      }
      return list
    }

    let message: string | undefined
    const attempt = async (retry: boolean): Promise<Result> => {
      const heads = await must(["ls-remote", input.remote, ref])
      const found = heads.split("\n").some((line) => line.endsWith(`\t${ref}`))
      if (found) await must(["fetch", "--quiet", "--no-tags", "--depth=1", input.remote, `+${ref}:${track}`])
      const parent = found ? (await must(["rev-parse", track])).trim() : undefined
      const staged = await stage()
      if (parent && staged.tree === (await must(["rev-parse", `${parent}^{tree}`])).trim()) {
        return { skipped: staged.skipped }
      }
      message ??=
        typeof input.message === "string" ? input.message : await input.message(await changes(parent, staged.tree))
      const sha = (
        await must(["commit-tree", "--no-gpg-sign", staged.tree, ...(parent ? ["-p", parent] : []), "-m", message], {
          env: who,
        })
      ).trim()
      const out = await run(["push", "--quiet", input.remote, `${sha}:${ref}`])
      if (out.exitCode === 0) return { sha, skipped: staged.skipped }
      if (retry) return attempt(false)
      throw new Failure("remote", 502, out.stderr.toString().trim())
    }

    return attempt(true)
  }
}
