import type { Plugin } from "@opencode/plugin"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { EnkFailure, refusal } from "./failure"
import { History } from "./history"
import { Locale } from "./locale"
import { Sentry } from "./sentry"
import { ServeTargets } from "./serve-targets"
import { SessionActivity } from "./session-activity"
import { TurnSummary } from "./turn"
import { WorkspaceRepo } from "./workspace-repo"
import * as Definitions from "./rpc"

// 팀이 짓다에서 연결한 GitHub 계정의 공개 저장소로 본행사 결과물을 올린다. 작업 폴더의 .git 은 건드리지 않고 버전 기록의 최신
// 커밋에서 올릴 트리를 만든다. 미리보기 브릿지 태그와 .env·node_modules 등은 빼고 올린다.

type Context = Plugin.Context

const WEB = "https://github.com"
const API = "https://api.github.com"
const AGENT = "jitda-opencode"
const ROUTE = "/api/v1/opencode/github"
const BRIDGE = "__preview-bridge.js"
const TAG = /[ \t]*<script\b[^>]*\bdata-preview-bridge\b[^>]*>\s*<\/script>[ \t]*(\r?\n)?/gi
const ATTEMPTS = 3
const BACKOFF = 500
const BUDGET = 60_000
const DETAIL = 300
const TRANSIENT: Code[] = ["remote", "missing"]
export type Repo = { owner: string; name: string; url: string; private?: boolean }
export type FirstPush = { attempts: number; code: Code; reason: string }
export type Status = {
  enabled: boolean
  connectUrl?: string
  login?: string
  linkedBy?: string
  app?: boolean
  repo?: Repo
  push?: { sha: string; time: number; by?: string }
  firstPush?: FirstPush
}
export type Result = { sha?: string }
export type Code =
  | "disabled"
  | "unlinked"
  | "norepo"
  | "exists"
  | "forbidden"
  | "revoked"
  | "app"
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
  app?: boolean
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

export class Failure extends EnkFailure<Code> {
  constructor(
    code: Code,
    status: 404 | 409 | 422 | 502,
    message?: string,
    readonly response?: Response,
  ) {
    super(code, status, message)
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

const stuck = new Map<string, FirstPush>()

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

async function rails<T>(sub: string, init?: { method: string; body: unknown }): Promise<T> {
  const target = backend()
  if (!target) throw new Failure("disabled", 409)
  const method = init?.method ?? "GET"
  const url = target.url + sub
  const res = await fetch(url, {
    method,
    headers: { Authorization: `token ${target.token}`, "Content-Type": "application/json" },
    body: init ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  }).catch((error) => {
    if (!quiet(`rails call failed:${sub}`))
      console.error("[jitda.github] rails call failed", { method, url, error: errorData(error) })
    return undefined
  })
  if (res?.ok) return (await res.json()) as T
  if (res && !quiet(`rails call rejected:${sub}:${res.status}`))
    console.error("[jitda.github] rails call rejected", { method, url, response: cut(res, await text(res), 500) })
  if (res?.status === 404) throw new Failure("missing", 404)
  if (res?.status === 409) throw new Failure("unlinked", 409)
  throw new Failure("remote", 502)
}

async function linked() {
  const hit = await link()
  if (!hit?.connected) throw new Failure("unlinked", 409)
  if (!hit.token) throw new Failure("remote", 502)
  return hit
}

export async function status(dir: string): Promise<Status> {
  if (!ServeTargets.isProject(dir)) return { enabled: false }
  const hit = await link()
  if (!hit?.enabled) return { enabled: false }
  return {
    enabled: true,
    connectUrl: hit.connect_url,
    login: hit.connected ? hit.login : undefined,
    linkedBy: hit.connected ? hit.linked_by : undefined,
    app: hit.connected ? hit.app : undefined,
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

function validName(name: string) {
  return REPO_NAME.test(name) && name !== "." && name !== ".."
}

export async function create(dir: string, input: { name: string; locale?: Locale.Locale }) {
  if (!validName(input.name)) throw new Failure("exists", 422, "invalid name")
  const hit = await linked()
  if (hit.app) throw new Failure("app", 422)
  const repo = shape(
    await request<Remote>(hit.token!, "POST", "/user/repos", { name: input.name, private: false, auto_init: false }),
  )
  await report({
    repo_owner: repo.owner,
    repo_name: repo.name,
    repo_url: repo.url,
    repo_private: repo.private ?? false,
  })
  await firstPush(dir, { ...hit, repo }, input.locale)
  return status(dir)
}

export async function repositories(dir: string): Promise<Repo[]> {
  if (!ServeTargets.isProject(dir)) throw new Failure("disabled", 409)
  const list = await rails<{ repositories: Repo[] }>("/repositories")
  return list.repositories.map((item) => ({
    owner: item.owner,
    name: item.name,
    url: item.url,
    private: item.private,
  }))
}

export async function select(dir: string, input: { owner: string; name: string; locale?: Locale.Locale }) {
  if (!ServeTargets.isProject(dir)) throw new Failure("disabled", 409)
  if (!input.owner || !validName(input.name)) throw new Failure("exists", 422, "invalid name")
  await rails("/repository", { method: "PUT", body: { repo_owner: input.owner, repo_name: input.name } })
  await firstPush(dir, await linked(), input.locale)
  return status(dir)
}

// 저장소를 만들자마자 지금 작업 폴더를 한 번 올린다. 마지막 기록 뒤에 바뀐 파일이 있으면 먼저 기록에 남긴다. AI 가 답하는
// 중이면 고치다 만 파일을 남기지 않도록 마지막 기록을 올리고, 나머지는 그 턴이 끝날 때 올라간다. 막 만든 저장소는 GitHub 에서
// 바로 안 보일 수 있어 일시적인 실패만 다시 시도하고, 끝내 실패해도 저장소 생성은 성공으로 두고 사유를 상태에 남긴다.
async function firstPush(dir: string, hit: Link, locale?: Locale.Locale) {
  const subject = TurnSummary.first(locale)
  await snapshot(dir, subject)
  const started = Date.now()
  for (let attempt = 1; ; attempt++) {
    const failure = await push(dir, { locale, subject }, hit).then(
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

async function snapshot(dir: string, subject: string) {
  await WorkspaceRepo.ignore(dir).catch((error) => console.error("[jitda.github] gitignore skipped", String(error)))
  if (SessionActivity.working(dir)) return
  await History.commit(dir, { message: subject }).catch((error) =>
    console.warn("[jitda.github] snapshot failed", String(error)),
  )
}

// 연결 화면에서 바로 올린다. 마지막 기록 뒤에 바뀐 파일이 있으면 먼저 기록에 남기고, 올릴 것이 없으면 pushed 가 false 다.
export async function manual(dir: string, locale?: Locale.Locale) {
  if (!(await status(dir)).enabled) throw new Failure("disabled", 409)
  const subject = TurnSummary.manual(locale)
  await snapshot(dir, subject)
  const result = await push(dir, { locale, subject })
  return { ...(await status(dir)), pushed: !!result.sha }
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

// 연결한 팀이면 버전 기록의 최신 커밋을 저장소에 올린다. 연결하지 않은 팀에는 아무것도 하지 않는다.
export async function sync(dir: string, locale?: Locale.Locale) {
  if (!ServeTargets.isProject(dir)) return
  const hit = await link()
  if (!hit?.enabled || !hit.connected || !hit.token || !hit.repo) return
  await push(dir, { locale }, hit)
}

export async function push(dir: string, input: { locale?: Locale.Locale; subject?: string }, known?: Link) {
  const hit = known ?? (await linked())
  if (!hit.repo) throw new Failure("norepo", 409)
  const remote = await request<Remote>(
    hit.token!,
    "GET",
    `/repos/${encodeURIComponent(hit.repo.owner)}/${encodeURIComponent(hit.repo.name)}`,
  )
  if (!hit.app && remote.permissions?.push === false) throw new Failure("forbidden", 409)
  if (remote.private !== (hit.repo.private ?? false)) {
    await report({ repo_private: remote.private }).catch(() => undefined)
  }
  const result = await publish({
    repo: WorkspaceRepo.open(dir),
    remote: `${WEB}/${hit.repo.owner}/${hit.repo.name}.git`,
    branch: remote.default_branch || "main",
    locale: input.locale,
    subject: input.subject,
    author: {
      name: hit.login || "Jitda",
      email: `${hit.github_user_id ? `${hit.github_user_id}+` : ""}${hit.login}@users.noreply.github.com`,
    },
    env: auth(hit.token!),
  })
  stuck.delete(dir)
  if (result.sha) await report({ pushed_sha: result.sha, pushed_by: null }).catch(() => undefined)
  return { ...result, url: result.sha ? `${hit.repo.url}/commit/${result.sha}` : hit.repo.url }
}

export function strip(text: string) {
  let clean = text
  for (let previous = ""; previous !== clean; ) {
    previous = clean
    clean = clean.replace(TAG, "")
  }
  return clean
}

// 기록 트리에서 짓다 미리보기 브릿지(번들 파일과 HTML 의 script 태그)를 걷어 낸 트리. 학생 저장소에는 이것만 올라간다.
async function publishable(repo: WorkspaceRepo.Repo, tree: string) {
  const env = { GIT_INDEX_FILE: path.join(repo.root, "github-index") }
  await repo.must(["read-tree", tree], { env })
  const files = (await repo.must(["ls-files", "-z"], { env })).split("\0").filter(Boolean)
  const bridges = files.filter((file) => path.posix.basename(file) === BRIDGE)
  if (bridges.length === files.length) throw new Failure("empty", 422)
  await WorkspaceRepo.each(repo, ["update-index", "--force-remove", "--"], bridges, { env })
  for (const file of files.filter((file) => /\.html?$/i.test(file))) {
    const text = await repo.must(["cat-file", "blob", `${tree}:${file}`])
    const clean = strip(text)
    if (clean === text) continue
    const tmp = path.join(repo.root, "stripped")
    await writeFile(tmp, clean)
    const blob = (await repo.must(["hash-object", "-w", "--no-filters", "--", tmp])).trim()
    await repo.must(["update-index", "--cacheinfo", `100644,${blob},${file}`], { env })
  }
  return (await repo.must(["write-tree"], { env })).trim()
}

// 버전 기록의 최신 커밋을 원격 브랜치 위에 새 커밋으로 올린다. 원격에서 따로 쌓인 커밋(GitHub 웹 편집 등)이 있으면 그 위에
// 얹으므로 force-push 하지 않는다. 작업 폴더와 인덱스를 건드리지 않아 기록과 다른 줄에서 돈다. 메시지는 기록 커밋의 제목에
// 원격과 달라진 파일 목록을 붙인다. 누가 먼저 올리든 같은 메시지가 된다.
export async function publish(input: {
  repo: WorkspaceRepo.Repo
  remote: string
  branch: string
  locale?: Locale.Locale
  subject?: string
  author: { name: string; email: string }
  env?: Record<string, string>
}): Promise<Result> {
  const { repo } = input
  const ref = `refs/heads/${input.branch}`
  const track = `refs/remotes/jitda/${input.branch}`
  const who = {
    GIT_AUTHOR_NAME: input.author.name,
    GIT_AUTHOR_EMAIL: input.author.email,
    GIT_COMMITTER_NAME: input.author.name,
    GIT_COMMITTER_EMAIL: input.author.email,
  }

  return repo.lock(async () => {
    const head = await WorkspaceRepo.rev(repo, WorkspaceRepo.HEAD)
    if (!head) throw new Failure("empty", 422)
    const tree = await publishable(repo, `${head}^{tree}`)
    const subject = input.subject ?? (await repo.must(["log", "-1", "--format=%s", head])).trim()
    const attempt = async (retry: boolean): Promise<Result> => {
      const heads = await repo.must(["ls-remote", input.remote, ref], { env: input.env })
      const found = heads.split("\n").some((line) => line.endsWith(`\t${ref}`))
      if (found) {
        await repo.must(["fetch", "--quiet", "--no-tags", "--depth=1", input.remote, `+${ref}:${track}`], {
          env: input.env,
        })
      }
      const parent = found ? await WorkspaceRepo.rev(repo, track) : undefined
      if (parent && tree === (await WorkspaceRepo.rev(repo, `${parent}^{tree}`))) return {}
      const changes = await WorkspaceRepo.diff(repo, parent && `${parent}^{tree}`, tree)
      const message = TurnSummary.compose(subject, changes, input.locale)
      const sha = (
        await repo.must(["commit-tree", "--no-gpg-sign", tree, ...(parent ? ["-p", parent] : []), "-m", message], {
          env: who,
        })
      ).trim()
      const out = await repo.run(["push", "--quiet", input.remote, `${sha}:${ref}`], { env: input.env })
      if (out.exitCode === 0) return { sha }
      if (retry) return attempt(false)
      throw new Failure("remote", 502, out.stderr.trim())
    }
    return attempt(true)
  }, "github")
}

export const Rpc = Definitions.Github

// RPC 출력은 JSON 이어야 해서 값이 없는 필드는 뺀다.
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value))

const failure = (method: string) => (error: unknown) => {
  if (!(error instanceof EnkFailure)) throw error
  if (error.status === 500 || notify.includes(error.code as Code)) alert("request failed", error, { method })
  return refusal(error)
}

export async function start(ctx: Context) {
  const directory = ctx.location.directory
  const registration = await ctx.rpc.register(Rpc, {
    status: async () => json(await status(directory)),
    createRepo: async (input) => {
      const { name, locale } = input as { name: string; locale?: unknown }
      return json(await create(directory, { name, locale: Locale.parse(locale) }).catch(failure("createRepo")))
    },
    repositories: async () =>
      json(
        await repositories(directory)
          .then((list) => ({ repositories: list }))
          .catch(failure("repositories")),
      ),
    selectRepo: async (input) => {
      const { owner, name, locale } = input as { owner: string; name: string; locale?: unknown }
      return json(await select(directory, { owner, name, locale: Locale.parse(locale) }).catch(failure("selectRepo")))
    },
    push: async (input) => {
      const { locale } = input as { locale?: unknown }
      return json(await manual(directory, Locale.parse(locale)).catch(failure("push")))
    },
  })

  return async () => {
    await registration.dispose()
  }
}

export * as GitHub from "./github"
