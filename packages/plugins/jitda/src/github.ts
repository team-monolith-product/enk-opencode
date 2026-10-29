import type { Plugin } from "@opencode/plugin"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { Env } from "./env"
import { Locale } from "./locale"
import { Sentry } from "./sentry"
import { ServeTargets } from "./serve-targets"
import * as Definitions from "./rpc"

// 팀이 짓다에서 연결한 GitHub 계정의 공개 저장소로 본행사 결과물을 올린다. 작업 폴더의 .git 은 건드리지 않고
// 데이터 디렉터리의 bare gitdir 로 커밋한다. 미리보기 브릿지 태그와 .env·node_modules 등은 빼고 올린다.

type Context = Plugin.Context

const WEB = "https://github.com"
const API = "https://api.github.com"
const AGENT = "jitda-opencode"
const ROUTE = "/api/v1/opencode/github"
const LIMIT = 100 * 1024 * 1024
const BRIDGE = "__preview-bridge.js"
const TAG = /[ \t]*<script\b[^>]*\bdata-preview-bridge\b[^>]*>\s*<\/script>[ \t]*(\r?\n)?/gi
const ATTEMPTS = 3
const BACKOFF = 500
const BUDGET = 60_000
const DETAIL = 300
const TRANSIENT: Code[] = ["remote", "missing"]
const IGNORED = [".playwright-mcp/"]
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
]
const MAX_FILES = 30
const MAX_SUBJECT = 72

export type Repo = { owner: string; name: string; url: string; private?: boolean }
export type FirstPush = { attempts: number; code: Code; reason: string }
export type Status = {
  enabled: boolean
  connectUrl?: string
  login?: string
  linkedBy?: string
  repo?: Repo
  push?: { sha: string; time: number; by?: string }
  firstPush?: FirstPush
}
export type Change = { status: "A" | "M" | "D"; file: string }
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

export type Response = {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  request?: string
}

// 사용자가 손쓸 수 없거나 운영에서 봐야 하는 실패만 Sentry 로 보낸다. 나머지는 정상 흐름이다.
export const notify: Code[] = ["forbidden", "revoked", "missing", "remote"]

type Link = {
  enabled: boolean
  connected: boolean
  connect_url?: string
  login?: string
  github_user_id?: number
  linked_by?: string
  token?: string
  repo?: Repo
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
    readonly response?: Response,
  ) {
    super(message || code)
    this.name = "GitHubFailure"
  }
}

function errorData(error: unknown) {
  if (error instanceof Error)
    return {
      type: error.name,
      message: error.message || error.name,
      stack: error.stack,
      cause: error.cause === undefined ? undefined : String(error.cause),
    }
  return { type: typeof error, message: String(error) }
}

export function dump(error: unknown) {
  const data = errorData(error)
  return error instanceof Failure ? { ...data, code: error.code, response: error.response } : data
}

function lean(error: unknown) {
  const data = dump(error)
  return error instanceof Failure ? { ...data, response: undefined } : data
}

const VOLATILE = /\/[^\s"']+|\d+/g

export function identity(message: string, error: unknown) {
  if (error instanceof Failure) {
    const site = error.response
      ? `${error.response.status}:${error.response.request ?? ""}`
      : error.message.replace(VOLATILE, "#").slice(0, 80)
    return `${message}:${error.code}:${site}`
  }
  const text = error instanceof Error ? `${error.name}:${error.message}` : String(error)
  return `${message}:${text.replace(VOLATILE, "#").slice(0, 120)}`
}

const REPO_PATH = /^(\w+ \/repos\/)[^/\s]+\/[^/\s?]+/

// 저장소가 달라도 같은 실패는 한 이슈로 묶는다.
export function scope(message: string, error: unknown): Sentry.Scope | undefined {
  if (!(error instanceof Failure)) return
  const call = error.response?.request?.replace(REPO_PATH, "$1:owner/:name") ?? ""
  return {
    tags: { "github.code": error.code, ...(error.response ? { "github.status": String(error.response.status) } : {}) },
    fingerprint: [message, error.code, String(error.response?.status ?? ""), call],
  }
}

export function alert(message: string, error: unknown, extra?: Record<string, unknown>) {
  console.error(`[jitda.github] ${message}`, { ...extra, error: lean(error) })
  Sentry.captureOnce(identity(message, error), error, { ...extra, error: dump(error) }, scope(message, error))
}

export function failed(error: unknown, sessionID: string) {
  if (error instanceof Failure && !notify.includes(error.code))
    return console.info("[jitda.github] sync skipped", { sessionID, code: error.code, reason: error.message })
  alert("sync failed", error, { sessionID })
}

const SECRET = /^(set-cookie|cookie|authorization|proxy-authorization|x-github-sso)$/i

async function text(res: globalThis.Response) {
  return res.text().catch((error) => `<unreadable body: ${String(error)}>`)
}

function cut(res: globalThis.Response, raw: string, cap = 4000, request?: string): Response {
  return {
    status: res.status,
    statusText: res.statusText,
    headers: Object.fromEntries([...res.headers].filter(([name]) => !SECRET.test(name))),
    body: raw.length > cap ? `${raw.slice(0, cap)}…(+${raw.length - cap} chars)` : raw,
    request,
  }
}

function quiet(key: string) {
  return !Sentry.due(`log:${key}`, 5 * 60_000)
}

const chains = new Map<string, Promise<unknown>>()
const stuck = new Map<string, FirstPush>()

function serial<T>(key: string, fn: () => Promise<T>) {
  const run = (chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn)
  chains.set(key, run)
  return run.finally(() => {
    if (chains.get(key) === run) chains.delete(key)
  })
}

// 본행사 작업 폴더에서만 연다. 튜토리얼 폴더를 같은 저장소로 올리면 결과물을 덮어쓴다.
export function serves(dir: string, env: NodeJS.ProcessEnv = process.env) {
  const target = ServeTargets.project(env)
  return !target || path.resolve(dir) === target.dir
}

function backend(env: NodeJS.ProcessEnv = process.env) {
  const url = env.ENK_HACKATHON_RAILS_URL
  const token = env.ENK_AI_USAGE_TOKEN
  if (!url || !token) return undefined
  return { url: url.replace(/\/+$/, "") + ROUTE, token }
}

async function link() {
  const rails = backend()
  if (!rails) return undefined
  const res = await fetch(rails.url, {
    headers: { Authorization: `token ${rails.token}` },
    signal: AbortSignal.timeout(15_000),
  }).catch((error) => {
    if (!quiet("rails link failed"))
      console.error("[jitda.github] rails link failed", { method: "GET", url: rails.url, error: errorData(error) })
    return undefined
  })
  if (!res?.ok) {
    if (res && !quiet(`rails link rejected:${res.status}`))
      console.error("[jitda.github] rails link rejected", {
        method: "GET",
        url: rails.url,
        response: cut(res, await text(res), 500),
      })
    return undefined
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
  }).catch((error) => {
    if (!quiet("rails report failed"))
      console.error("[jitda.github] rails report failed", {
        method: "PUT",
        url: rails.url,
        sent: body,
        error: errorData(error),
      })
    return undefined
  })
  if (!res?.ok) {
    if (res && !quiet(`rails report rejected:${res.status}`))
      console.error("[jitda.github] rails report rejected", {
        method: "PUT",
        url: rails.url,
        sent: body,
        response: cut(res, await text(res), 500),
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
    firstPush: stuck.get(dir),
  }
}

async function request<T>(token: string, method: string, url: string, body?: unknown): Promise<T> {
  const started = Date.now()
  const res = await fetch(API + url, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": AGENT,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  }).catch((error) => {
    console.error("[jitda.github] api failed", {
      method,
      url,
      sent: body,
      ms: Date.now() - started,
      error: errorData(error),
    })
    throw new Failure("remote", 502, String(error))
  })
  if (res.ok) {
    console.info("[jitda.github] api", { method, url, status: res.status, ms: Date.now() - started })
    return (await res.json()) as T
  }
  const raw = await text(res)
  const response = cut(res, raw, 4000, `${method} ${url}`)
  const detail = (await Promise.resolve()
    .then(() => JSON.parse(raw))
    .catch(() => undefined)) as { message?: string; errors?: { message?: string }[] } | undefined
  const message = detail?.errors?.[0]?.message || detail?.message || res.statusText
  console.error("[jitda.github] api rejected", {
    method,
    url,
    sent: body,
    ms: Date.now() - started,
    response: { ...response, request: undefined },
  })
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

export const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/

type Describe = (changes: Change[]) => Promise<string>

export async function create(dir: string, input: { name: string; message?: string | Describe }) {
  if (!REPO_NAME.test(input.name) || input.name === "." || input.name === "..")
    throw new Failure("exists", 422, "invalid name")
  const hit = await linked()
  const repo = shape(
    await request<Remote>(hit.token!, "POST", "/user/repos", { name: input.name, private: false, auto_init: false }),
  )
  await report({ repo_owner: repo.owner, repo_name: repo.name, repo_url: repo.url })
  await firstPush(dir, { ...hit, repo }, input.message ?? "Initial commit from Jitda")
  return status(dir)
}

// 막 만든 저장소는 GitHub 에서 바로 안 보일 수 있어 일시적인 실패만 다시 시도한다.
async function firstPush(dir: string, hit: Link, message: string | Describe) {
  const started = Date.now()
  for (let attempt = 1; ; attempt++) {
    const failure = await push(dir, { message }, hit).then(
      () => undefined,
      (error) => (error instanceof Failure ? error : new Failure("remote", 502, String(error))),
    )
    if (!failure) return
    console.error("[jitda.github] first push failed", { attempt, error: lean(failure) })
    if (!TRANSIENT.includes(failure.code) || attempt >= ATTEMPTS || Date.now() - started > BUDGET) {
      if (notify.includes(failure.code)) alert("first push gave up", failure, { attempt })
      stuck.set(dir, { attempts: attempt, code: failure.code, reason: failure.message.slice(0, DETAIL) })
      return
    }
    await sleep(BACKOFF * attempt)
  }
}

function auth(token: string) {
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `http.${WEB}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
  }
}

function dataDir(env: NodeJS.ProcessEnv = process.env) {
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode")
}

// 에이전트가 남기는 부산물 폴더를 작업 폴더의 .gitignore 에 적어 둔다. 이미 있으면 건드리지 않는다.
export async function ignore(dir: string) {
  const file = path.join(dir, ".gitignore")
  const text = await readFile(file, "utf8").catch(() => "")
  const lines = new Set(text.split(/\r?\n/).map((line) => line.trim().replace(/\/$/, "")))
  const missing = IGNORED.filter((item) => !lines.has(item.replace(/\/$/, "")))
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
  const gitdir = path.join(dataDir(), "github", createHash("sha1").update(dir).digest("hex"))
  const repo = hit.repo
  const result = await serial(gitdir, async () => {
    await ignore(dir).catch((error) => console.error("[jitda.github] gitignore skipped", String(error)))
    return publish({
      gitdir,
      worktree: dir,
      remote: `${WEB}/${repo.owner}/${repo.name}.git`,
      branch: remote.default_branch || "main",
      message: input.message,
      author: {
        name: hit.login || "Jitda",
        email: `${hit.github_user_id ? `${hit.github_user_id}+` : ""}${hit.login}@users.noreply.github.com`,
      },
      env: auth(hit.token!),
    })
  })
  stuck.delete(dir)
  if (result.sha) await report({ pushed_sha: result.sha, pushed_by: null }).catch(() => undefined)
  return { ...result, url: result.sha ? `${repo.url}/commit/${result.sha}` : repo.url }
}

// 작업 폴더 .gitignore 의 부정 패턴(!)이 info/exclude 보다 앞서므로 부산물 폴더는 경로로도 한 번 더 거른다.
function leftover(file: string) {
  return file.split("/").some((part) => LEFTOVERS.includes(part))
}

export function strip(text: string) {
  let clean = text
  for (let previous = ""; previous !== clean; ) {
    previous = clean
    clean = clean.replace(TAG, "")
  }
  return clean
}

type Run = { exitCode: number; stdout: string; stderr: string }

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

export async function publish(input: {
  gitdir: string
  worktree: string
  remote: string
  branch: string
  message: string | Describe
  author: { name: string; email: string }
  env?: Record<string, string>
}): Promise<{ sha?: string; skipped: string[] }> {
  const base = (tree?: string) => [
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.quotepath=false",
    "--git-dir",
    input.gitdir,
    "--work-tree",
    tree ?? input.worktree,
  ]
  const run = (args: string[], options?: { env?: Record<string, string>; tree?: string }) =>
    git([...base(options?.tree), ...args], { cwd: input.worktree, env: { ...input.env, ...options?.env } })
  const must = async (args: string[], options?: { env?: Record<string, string>; tree?: string }) => {
    const out = await run(args, options)
    if (out.exitCode !== 0) throw new Failure("remote", 502, out.stderr.trim())
    return out.stdout
  }

  if (!existsSync(path.join(input.gitdir, "HEAD"))) {
    await mkdir(input.gitdir, { recursive: true })
    const init = await git(["init", "--quiet", "--bare", input.gitdir], { cwd: input.gitdir })
    if (init.exitCode !== 0) throw new Failure("remote", 502, init.stderr.trim())
  }
  await mkdir(path.join(input.gitdir, "info"), { recursive: true })
  await writeFile(path.join(input.gitdir, "info", "exclude"), EXCLUDE.join("\n") + "\n")

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
    return [...items.filter((item) => !item.endsWith("/")).map((item) => path.posix.join(dir, item)), ...nested.flat()]
  }

  const stage = async () => {
    await must(["read-tree", "--empty"])
    const files = await Promise.all(
      (await scan(""))
        .filter((file) => !Env.isSecretFile(file) && path.posix.basename(file) !== BRIDGE && !leftover(file))
        .map(async (file) => ({
          file,
          size: (await lstat(path.join(input.worktree, file)).catch(() => undefined))?.size,
        })),
    )
    const keep = files.filter((item) => item.size !== undefined && item.size <= LIMIT).map((item) => item.file)
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
    for (let i = 0; i < plain.length; i += 200)
      await must(["update-index", "--add", "--remove", "--", ...plain.slice(i, i + 200)])
    for (const item of stripped) {
      const tmp = path.join(input.gitdir, "stripped")
      await writeFile(tmp, item.clean)
      const blob = (await must(["hash-object", "-w", "--no-filters", "--", tmp])).trim()
      await must(["update-index", "--add", "--cacheinfo", `100644,${blob},${item.file}`])
    }
    return {
      tree: (await must(["write-tree"])).trim(),
      skipped: files.filter((item) => (item.size ?? 0) > LIMIT).map((item) => item.file),
    }
  }

  const changes = async (parent: string | undefined, tree: string): Promise<Change[]> => {
    if (!parent)
      return (await must(["ls-tree", "-r", "-z", "--name-only", tree]))
        .split("\0")
        .filter(Boolean)
        .map((file) => ({ status: "A", file }))
    const out = (await must(["diff-tree", "-r", "-z", "--no-renames", "--name-status", `${parent}^{tree}`, tree]))
      .split("\0")
      .filter(Boolean)
    const list: Change[] = []
    for (let i = 0; i + 1 < out.length; i += 2) {
      const value = out[i]
      list.push({ status: value === "A" || value === "D" ? value : "M", file: out[i + 1]! })
    }
    return list
  }

  let message: string | undefined
  const attempt = async (retry: boolean): Promise<{ sha?: string; skipped: string[] }> => {
    const heads = await must(["ls-remote", input.remote, ref])
    const found = heads.split("\n").some((line) => line.endsWith(`\t${ref}`))
    if (found) await must(["fetch", "--quiet", "--no-tags", "--depth=1", input.remote, `+${ref}:${track}`])
    const parent = found ? (await must(["rev-parse", track])).trim() : undefined
    const staged = await stage()
    if (parent && staged.tree === (await must(["rev-parse", `${parent}^{tree}`])).trim())
      return { skipped: staged.skipped }
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
    throw new Failure("remote", 502, out.stderr.trim())
  }

  return attempt(true)
}

const LABEL = {
  ko: {
    A: "추가",
    M: "수정",
    D: "삭제",
    fallback: "짓다에서 작업한 내용",
    first: "짓다에서 처음 올린 내용",
    manual: "짓다에서 직접 올린 내용",
  },
  en: {
    A: "Add",
    M: "Update",
    D: "Delete",
    fallback: "Update from Jitda",
    first: "First push from Jitda",
    manual: "Manual push from Jitda",
  },
} as const

export type Turn = { request: string; reply: string; locale: "ko" | "en" | "ar"; model?: { providerID: string; id: string } }

export function compose(subject: string, changes: Change[], locale: "ko" | "en" | "ar" = "ko") {
  const label = LABEL[locale === "ko" ? "ko" : "en"]
  const lines = changes.slice(0, MAX_FILES).map((change) => `- ${label[change.status]}: ${change.file}`)
  if (changes.length > MAX_FILES) lines.push(`- … +${changes.length - MAX_FILES}`)
  const clipped = subject.length > MAX_SUBJECT ? subject.slice(0, MAX_SUBJECT - 1) + "…" : subject
  return [clipped, ...(lines.length ? ["", ...lines] : [])].join("\n")
}

export function first(locale: "ko" | "en" | "ar" = "ko"): Describe {
  return async (changes) => compose(LABEL[locale === "ko" ? "ko" : "en"].first, changes, locale)
}

export function manual(locale: "ko" | "en" | "ar" = "ko"): Describe {
  return async (changes) => compose(LABEL[locale === "ko" ? "ko" : "en"].manual, changes, locale)
}

// 대화가 끝나기를 기다리지 않고 지금 파일을 올린다. 본행사 폴더가 아니면 막는다.
export async function pushNow(dir: string, locale?: "ko" | "en" | "ar") {
  if (!(await status(dir)).enabled) throw new Failure("disabled", 409)
  const result = await push(dir, { message: manual(locale) })
  return { ...(await status(dir)), pushed: !!result.sha }
}

type Message = {
  type: string
  text?: string
  content?: Array<{ type: string; text?: string }>
  metadata?: Record<string, unknown>
  model?: { providerID: string; id: string }
}

// 가장 최근 사용자 요청과 그 뒤 마지막 AI 답을 고른다.
export function latest(messages: ReadonlyArray<Message>): Turn | undefined {
  const index = messages.findLastIndex((message) => message.type === "user" && (message.text ?? "").trim())
  const found = messages[index]
  if (!found) return undefined
  const replies = messages.slice(index + 1).filter((message) => message.type === "assistant")
  const reply =
    replies
      .map((message) =>
        (message.content ?? [])
          .flatMap((part) => (part.type === "text" && part.text?.trim() ? [part.text.trim()] : []))
          .join("\n"),
      )
      .filter(Boolean)
      .at(-1) ?? ""
  return {
    request: (found.text ?? "").trim(),
    reply,
    locale: found.metadata?.locale === "en" || found.metadata?.locale === "ar" ? found.metadata.locale : "ko",
    model: replies.at(-1)?.model,
  }
}

export const Rpc = Definitions.Github

// RPC 출력은 JSON 이어야 해서 값이 없는 필드는 뺀다.
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value))

const failure = (method: string) => (error: unknown) => {
  if (!(error instanceof Failure)) throw error
  if (notify.includes(error.code)) alert("request failed", error, { method })
  return { error: { code: error.code, status: error.status, message: error.message } }
}

export async function start(ctx: Context) {
  const directory = ctx.location.directory
  const registration = await ctx.rpc.register(Rpc, {
    status: async () => json(await status(directory)),
    createRepo: async (input) => {
      const { name, locale } = input as { name: string; locale?: unknown }
      return json(await create(directory, { name, message: first(Locale.parse(locale)) }).catch(failure("createRepo")))
    },
    push: async (input) => {
      const { locale } = input as { locale?: unknown }
      return json(await pushNow(directory, Locale.parse(locale)).catch(failure("push")))
    },
  })

  const describe = async (turn: Turn, changes: Change[]) => {
    const content = [turn.request, turn.reply].filter(Boolean).join("\n\n").slice(0, 4000)
    const title = turn.model
      ? await ctx.generate
          .text({
            model: turn.model,
            prompt: `Generate a title for the change made in this conversation:\n\n${content}`,
          })
          .then((result) =>
            result.text
              .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
              .split("\n")
              .map((line) => line.trim())
              .find(Boolean),
          )
          .catch((error) => {
            console.error("[jitda.github] summary failed", String(error))
            return undefined
          })
      : undefined
    const fallback = turn.request
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean)
    return compose(title || fallback || LABEL[turn.locale === "ko" ? "ko" : "en"].fallback, changes, turn.locale)
  }

  const sync = async (sessionID: string) => {
    const current = await status(directory)
    if (!current.login || !current.repo) return
    const session = await ctx.session.get({ sessionID }).catch(() => undefined)
    if (!session || (session as { parentID?: string }).parentID) return
    const turn = latest(await ctx.session.context({ sessionID }).catch(() => []))
    if (!turn) return
    await push(directory, { message: (changes) => describe(turn, changes) })
  }

  const sessions = new Set<string>()
  const controller = new AbortController()
  void (async () => {
    while (!controller.signal.aborted) {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const value = event as { type: string; location?: { directory?: string }; data?: { sessionID?: string } }
          const sessionID = value.data?.sessionID
          if (!sessionID) continue
          if (value.location) {
            if (value.location.directory === directory) sessions.add(sessionID)
            continue
          }
          if (value.type === "session.execution.succeeded" && sessions.has(sessionID))
            void sync(sessionID).catch((error) => failed(error, sessionID))
        }
      } catch {
        if (controller.signal.aborted) return
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  })()

  return async () => {
    controller.abort()
    await registration.dispose()
  }
}

export * as GitHub from "./github"
