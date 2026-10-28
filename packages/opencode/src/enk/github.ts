import { mkdir, lstat, readFile, writeFile } from "fs/promises"
import path from "path"
import { setTimeout as sleep } from "node:timers/promises"
import { Global } from "../global"
import { EnvFile } from "../util/env-file"
import { errorData } from "../util/error"
import { git } from "../util/git"
import { Hash } from "../util/hash"
import { Log } from "../util/log"
import { SentryReporter } from "../util/sentry"
import { ServeTargets } from "./serve-targets"

export namespace GitHub {
  const log = Log.create({ service: "github" })
  const web = "https://github.com"
  const api = "https://api.github.com"
  const agent = "jitda-opencode"
  const route = "/api/v1/opencode/github"
  const limit = 100 * 1024 * 1024
  const bridge = "__preview-bridge.js"
  const attempts = 3
  const backoff = 500
  const budget = 60_000
  const detail = 300
  const transient: Code[] = ["remote", "missing"]
  const tag = /[ \t]*<script\b[^>]*\bdata-preview-bridge\b[^>]*>\s*<\/script>[ \t]*(\r?\n)?/gi
  const ignored = [".playwright-mcp/"]
  const leftovers = ignored.map((item) => item.replace(/\/$/, ""))
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
    ...ignored,
    ".DS_Store",
  ]

  export type Repo = { owner: string; name: string; url: string; private?: boolean }
  export type Push = { sha: string; time: number; by?: string }
  export type FirstPush = { attempts: number; code: Code; reason: string }
  export type Status = {
    enabled: boolean
    connectUrl?: string
    login?: string
    linkedBy?: string
    repo?: Repo
    push?: Push
    firstPush?: FirstPush
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

  export const alerting: Code[] = ["forbidden", "revoked", "missing", "remote"]

  export function dump(err: unknown) {
    return err instanceof Failure ? { ...errorData(err), code: err.code, response: err.response } : errorData(err)
  }

  export function alert(message: string, err: unknown, extra?: Record<string, unknown>) {
    const error = dump(err)
    log.error(message, { ...extra, error })
    SentryReporter.captureException(err, { ...extra, error })
  }

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

  export type Response = {
    status: number
    statusText: string
    headers: Record<string, string>
    body: string
  }

  export class Failure extends Error {
    constructor(
      readonly code: Code,
      readonly status: 404 | 409 | 422 | 502,
      message?: string,
      readonly response?: Response,
    ) {
      super(message || code)
      this.name = "GitHubFailure"
    }
  }

  const chains = new Map<string, Promise<unknown>>()
  const failed = new Map<string, FirstPush>()

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
    }).catch((err) => {
      log.warn("rails link failed", { method: "GET", url: rails.url, error: errorData(err) })
      return undefined
    })
    if (!res?.ok) {
      if (res) log.warn("rails link rejected", { method: "GET", url: rails.url, ...(await snapshot(res)) })
      return
    }
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
    }).catch((err) => {
      log.warn("rails report failed", { method: "PUT", url: rails.url, requestBody: body, error: errorData(err) })
      return undefined
    })
    if (!res?.ok) {
      if (res)
        log.warn("rails report rejected", {
          method: "PUT",
          url: rails.url,
          requestBody: body,
          ...(await snapshot(res)),
        })
      throw new Failure("remote", 502)
    }
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
      firstPush: failed.get(dir),
    }
  }

  async function snapshot(res: globalThis.Response): Promise<Response> {
    return {
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers),
      body: await res.text().catch((err) => `<unreadable body: ${String(err)}>`),
    }
  }

  async function request<T>(token: string, method: string, url: string, body?: unknown): Promise<T> {
    const started = Date.now()
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
      log.warn("api failed", { method, url, requestBody: body, ms: Date.now() - started, error: errorData(err) })
      throw new Failure("remote", 502, String(err))
    })
    if (res.ok) {
      log.info("api", { method, url, status: res.status, ms: Date.now() - started })
      return (await res.json()) as T
    }
    const response = await snapshot(res)
    const raw = response.body
    const detail = (() => {
      try {
        return JSON.parse(raw) as { message?: string; errors?: { message?: string }[] }
      } catch {
        return undefined
      }
    })()
    const message = detail?.errors?.[0]?.message || detail?.message || res.statusText
    log.warn("api rejected", { method, url, requestBody: body, ms: Date.now() - started, ...response })
    if (res.status === 401) {
      await report({ revoked: true }).catch(() => undefined)
      throw new Failure("revoked", 409, message, response)
    }
    if (res.status === 404) throw new Failure("missing", 404, message, response)
    if (res.status === 422) throw new Failure("exists", 422, message, response)
    throw new Failure("remote", 502, message, response)
  }

  const shape = (remote: Remote): Repo => ({
    owner: remote.owner.login,
    name: remote.name,
    url: remote.html_url,
    private: remote.private,
  })

  export async function create(dir: string, input: { name: string; message?: string | Describe }) {
    const hit = await linked()
    const repo = shape(
      await request<Remote>(hit.token!, "POST", "/user/repos", { name: input.name, private: false, auto_init: false }),
    )
    await report({ repo_owner: repo.owner, repo_name: repo.name, repo_url: repo.url })
    await firstPush(dir, { ...hit, repo }, input.message ?? "Initial commit from Jitda")
    return status(dir)
  }

  async function firstPush(dir: string, hit: Link, message: string | Describe) {
    const started = Date.now()
    for (let attempt = 1; ; attempt++) {
      const failure = await push(dir, { message }, hit).then(
        () => undefined,
        (err) => (err instanceof Failure ? err : new Failure("remote", 502, String(err))),
      )
      if (!failure) return
      log.warn("first push failed", { attempt, error: dump(failure) })
      if (!transient.includes(failure.code) || attempt >= attempts || Date.now() - started > budget) {
        if (alerting.includes(failure.code)) alert("first push gave up", failure, { attempt })
        failed.set(dir, { attempts: attempt, code: failure.code, reason: failure.message.slice(0, detail) })
        return
      }
      await sleep(backoff * attempt)
    }
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

  /** 에이전트가 남기는 부산물 폴더를 학생 작업 폴더의 .gitignore 에 적어 둔다. 이미 있으면 건드리지 않는다. */
  export async function ignore(dir: string) {
    const file = path.join(dir, ".gitignore")
    const text = await readFile(file, "utf8").catch(() => "")
    const lines = new Set(text.split(/\r?\n/).map((line) => line.trim().replace(/\/$/, "")))
    const missing = ignored.filter((item) => !lines.has(item.replace(/\/$/, "")))
    if (missing.length === 0) return
    await writeFile(file, text + (text && !text.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n")
  }

  export async function push(dir: string, input: { message: string | Describe }, known?: Link) {
    const hit = known ?? (await linked())
    if (!hit.repo) throw new Failure("norepo", 409)
    const remote = await request<Remote>(
      hit.token!,
      "GET",
      `/repos/${encodeURIComponent(hit.repo.owner)}/${encodeURIComponent(hit.repo.name)}`,
    )
    if (remote.permissions?.push === false) throw new Failure("forbidden", 409)
    const gitdir = path.join(Global.Path.data, "github", Hash.fast(dir))
    const result = await serial(gitdir, async () => {
      await ignore(dir).catch((err) => log.warn("gitignore skipped", { error: String(err) }))
      return publish({
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
      })
    })
    failed.delete(dir)
    if (result.sha) {
      await report({ pushed_sha: result.sha, pushed_by: null }).catch(() => undefined)
      log.info("pushed", { sha: result.sha })
    }
    return { ...result, url: result.sha ? `${hit.repo.url}/commit/${result.sha}` : hit.repo.url }
  }

  /** 학생 .gitignore 의 부정 패턴(!)이 info/exclude 보다 앞서므로, 부산물 폴더는 경로로도 한 번 더 거른다. */
  function leftover(file: string) {
    return file.split("/").some((part) => leftovers.includes(part))
  }

  function strip(text: string) {
    let clean = text
    for (let previous = ""; previous !== clean; ) {
      previous = clean
      clean = clean.replace(tag, "")
    }
    return clean
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
          .filter((file) => !EnvFile.isSecretFile(file) && path.posix.basename(file) !== bridge && !leftover(file))
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
              const clean = strip(text)
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
