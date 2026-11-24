import { readFile, rm, writeFile } from "fs/promises"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import path from "path"
import { setTimeout as sleep } from "node:timers/promises"
import { errorData } from "../util/error"
import { Log } from "../util/log"
import { SentryReporter } from "../util/sentry"
import { EnkFailure } from "./failure"
import { SessionStatus } from "../session/status"
import { Hash } from "../util/hash"
import { History } from "./history"
import { Rails } from "./rails"
import { ServeTargets } from "./serve-targets"
import type { Locale } from "./locale"
import { TurnSummary } from "./turn"
import { WorkspaceRepo } from "./workspace-repo"

export namespace GitHub {
  const log = Log.create({ service: "github" })
  const web = "https://github.com"
  const api = "https://api.github.com"
  const agent = "jitda-opencode"
  const route = "/api/v1/opencode/github"
  const bridge = "__preview-bridge.js"
  const attempts = 3
  const backoff = 500
  const budget = 60_000
  const detail = 300
  const transient: Code[] = ["remote", "missing"]
  const tag = /[ \t]*<script\b[^>]*\bdata-preview-bridge\b[^>]*>\s*<\/script>[ \t]*(\r?\n)?/gi

  export type Repo = { owner: string; name: string; url: string; private?: boolean }
  export type Push = { sha: string; time: number; by?: string }
  export type FirstPush = { attempts: number; code: Code; reason: string }
  export type Status = {
    enabled: boolean
    connectUrl?: string
    manageUrl?: string
    login?: string
    linkedBy?: string
    app?: boolean
    repo?: Repo
    push?: Push
    firstPush?: FirstPush
    conflict?: Conflict & { compare?: string }
  }
  /**
   * GitHub 에서 따로 바뀐 곳과 짓다에서 바뀐 곳이 겹쳐 기본 브랜치 대신 `branch` 에 올린 상태. `linking` 은 짓다가
   * 아직 올린 적 없는 저장소를 연결했는데 이미 다른 내용이 있던 경우다.
   */
  export type Conflict = {
    branch: string
    target: string
    files: string[]
    resolving: boolean
    linking?: boolean
    queued?: Choose
    owner?: string
    remote?: string
  }
  export type Choose = "ours" | "theirs" | "ai"
  export type Result = { sha?: string; conflict?: Conflict; absorbed?: number }
  export type Prefer = "ours" | "theirs"
  export type Choice = { label: string; description: string }
  export type Code =
    | "disabled"
    | "unlinked"
    | "norepo"
    | "exists"
    | "forbidden"
    | "revoked"
    | "app"
    | "selected"
    | "missing"
    | "empty"
    | "remote"
    | "clean"
    | "busy"

  export const notify: Code[] = ["forbidden", "revoked", "missing", "remote"]

  export function dump(err: unknown) {
    const { formatted: _, ...error } = errorData(err) as ReturnType<typeof errorData> & { formatted?: string }
    return err instanceof Failure ? { ...error, code: err.code, response: err.response } : error
  }

  function lean(err: unknown) {
    const error = dump(err)
    return err instanceof Failure ? { ...error, response: undefined } : error
  }

  const volatile = /\/[^\s"']+|\d+/g

  export function identity(message: string, err: unknown) {
    if (err instanceof Failure) {
      const site = err.response
        ? `${err.response.status}:${err.response.request ?? ""}`
        : err.message.replace(volatile, "#").slice(0, 80)
      return `${message}:${err.code}:${site}`
    }
    const text = err instanceof Error ? `${err.name}:${err.message}` : String(err)
    return `${message}:${text.replace(volatile, "#").slice(0, 120)}`
  }

  const repoPath = /^(\w+ \/repos\/)[^/\s]+\/[^/\s?]+/

  export function scope(message: string, err: unknown): SentryReporter.Scope | undefined {
    if (!(err instanceof Failure)) return
    const call = err.response?.request?.replace(repoPath, "$1:owner/:name") ?? ""
    return {
      tags: { "github.code": err.code, ...(err.response ? { "github.status": String(err.response.status) } : {}) },
      fingerprint: [message, err.code, String(err.response?.status ?? ""), call],
    }
  }

  export function alert(message: string, err: unknown, extra?: Record<string, unknown>) {
    log.error(message, { ...extra, error: lean(err) })
    SentryReporter.captureOnce(identity(message, err), err, { ...extra, error: dump(err) }, scope(message, err))
  }

  type Link = {
    enabled: boolean
    connected: boolean
    connect_url?: string
    manage_url?: string
    login?: string
    github_user_id?: number
    linked_by?: string
    app?: boolean
    token?: string
    repo?: { owner: string; name: string; url: string; private?: boolean }
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
    request?: string
  }

  export class Failure extends EnkFailure<Code> {
    constructor(
      code: Code,
      status: ContentfulStatusCode,
      message?: string,
      readonly response?: Response,
    ) {
      super(code, status, message)
    }
  }

  const failed = new Map<string, FirstPush & { repo?: string }>()

  const repoKey = (repo?: Repo) => (repo ? `${repo.owner}/${repo.name}` : undefined)

  function lastFailure(dir: string, repo?: Repo): FirstPush | undefined {
    const hit = failed.get(dir)
    if (!hit) return
    if (hit.repo !== repoKey(repo)) {
      failed.delete(dir)
      return
    }
    const { repo: _, ...first } = hit
    return first
  }

  const conflicts = new Map<string, Conflict | null>()
  const settled = new Set<(dir: string) => void>()

  /** 충돌 상태는 기록 저장소 옆 파일에도 남긴다. pod 가 다시 떠도 연결 창과 고르기가 이어진다. */
  function conflictFile(dir: string) {
    return path.join(WorkspaceRepo.open(dir).root, "github-conflict.json")
  }

  export async function conflictOf(dir: string): Promise<Conflict | undefined> {
    if (conflicts.has(dir)) return conflicts.get(dir) ?? undefined
    const raw = await readFile(conflictFile(dir), "utf8").catch(() => undefined)
    const parsed = (() => {
      if (!raw) return null
      try {
        return JSON.parse(raw) as Conflict
      } catch {
        return null
      }
    })()
    conflicts.set(dir, parsed)
    return parsed ?? undefined
  }

  async function keep(dir: string, conflict?: Conflict) {
    conflicts.set(dir, conflict ?? null)
    if (conflict) await writeFile(conflictFile(dir), JSON.stringify(conflict)).catch(() => undefined)
    else await rm(conflictFile(dir), { force: true }).catch(() => undefined)
  }

  function remoteOf(repo: Repo) {
    return `${web}/${repo.owner}/${repo.name}.git`
  }

  async function current(dir: string, remote: string) {
    const conflict = await conflictOf(dir)
    if (!conflict || conflict.remote === remote) return conflict
    await keep(dir)
    for (const fn of settled) fn(dir)
    return undefined
  }

  export function onSettle(fn: (dir: string) => void) {
    settled.add(fn)
    return () => settled.delete(fn)
  }

  export async function queue(dir: string, choice?: Choose, owner?: string) {
    const conflict = await conflictOf(dir)
    if (!conflict) throw new Failure("clean", 409)
    await keep(dir, { ...conflict, queued: choice, owner: choice ? owner : undefined })
  }

  async function link(): Promise<Link | undefined> {
    const rails = Rails.endpoint(route)
    if (!rails) return
    const res = await fetch(rails.url, { headers: rails.headers, signal: AbortSignal.timeout(15_000) }).catch((err) => {
      if (!quiet("rails link failed"))
        log.error("rails link failed", { method: "GET", url: rails.url, error: errorData(err) })
      return undefined
    })
    if (!res?.ok) {
      if (res && !quiet(`rails link rejected:${res.status}`)) {
        log.error("rails link rejected", { method: "GET", url: rails.url, response: cut(res, await text(res), 500) })
      }
      return
    }
    return (await res.json().catch(() => undefined)) as Link | undefined
  }

  async function report(body: Record<string, string | boolean | null>) {
    const rails = Rails.endpoint(route)
    if (!rails) return
    const res = await fetch(rails.url, {
      method: "PUT",
      headers: { ...rails.headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    }).catch((err) => {
      if (!quiet("rails report failed")) {
        log.error("rails report failed", { method: "PUT", url: rails.url, sent: body, error: errorData(err) })
      }
      return undefined
    })
    if (!res?.ok) {
      if (res && !quiet(`rails report rejected:${res.status}`)) {
        log.error("rails report rejected", {
          method: "PUT",
          url: rails.url,
          sent: body,
          response: cut(res, await text(res), 500),
        })
      }
      throw new Failure("remote", 502)
    }
  }

  async function rails<T>(sub: string, init?: { method: string; body: unknown }): Promise<T> {
    const target = Rails.endpoint(route)
    if (!target) throw new Failure("disabled", 409)
    const res = await fetch(target.url + sub, {
      method: init?.method,
      headers: { ...target.headers, "Content-Type": "application/json" },
      body: init ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    }).catch(() => undefined)
    if (res?.ok) return (await res.json()) as T
    if (res?.status === 404) throw new Failure("missing", 404)
    if (res?.status === 409) {
      const body = (await res.json().catch(() => undefined)) as { errors?: { title?: string }[] } | undefined
      throw new Failure(body?.errors?.[0]?.title === "AlreadySelected" ? "selected" : "unlinked", 409)
    }
    throw new Failure("remote", 502)
  }

  async function linked() {
    const hit = await link()
    if (!hit?.connected) throw new Failure("unlinked", 409)
    if (!hit.token) throw new Failure("remote", 502)
    return hit
  }

  /** 본행사 작업 폴더에서만 연다. 튜토리얼 폴더를 같은 저장소로 올리면 결과물을 덮어쓴다. */
  export async function status(dir: string): Promise<Status> {
    if (!ServeTargets.isProject(dir)) return { enabled: false }
    const hit = await link()
    if (!hit?.enabled) return { enabled: false }
    return {
      enabled: true,
      connectUrl: hit.connect_url,
      manageUrl: hit.connected ? hit.manage_url : undefined,
      login: hit.connected ? hit.login : undefined,
      linkedBy: hit.connected ? hit.linked_by : undefined,
      app: hit.connected ? hit.app : undefined,
      repo: hit.repo,
      push: hit.push ? { sha: hit.push.sha, time: hit.push.at, by: hit.push.by } : undefined,
      firstPush: lastFailure(dir, hit.repo),
      conflict: await shown(dir, hit),
    }
  }

  async function shown(dir: string, hit: Link) {
    if (!hit.repo) return
    const conflict = await current(dir, remoteOf(hit.repo))
    if (!conflict) return
    const { remote: _, owner: __, ...rest } = conflict
    return { ...rest, compare: `${hit.repo.url}/compare/${conflict.target}...${conflict.branch}` }
  }

  const secret = /^(set-cookie|cookie|authorization|proxy-authorization|x-github-sso)$/i

  async function text(res: globalThis.Response) {
    return res.text().catch((err) => `<unreadable body: ${String(err)}>`)
  }

  function cut(res: globalThis.Response, raw: string, cap = 4000, request?: string): Response {
    return {
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries([...res.headers].filter(([name]) => !secret.test(name))),
      body: raw.length > cap ? `${raw.slice(0, cap)}…(+${raw.length - cap} chars)` : raw,
      request,
    }
  }

  function quiet(key: string) {
    return !SentryReporter.due(`log:${key}`, 5 * 60_000)
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
      log.error("api failed", { method, url, sent: body, ms: Date.now() - started, error: errorData(err) })
      throw new Failure("remote", 502, String(err))
    })
    if (res.ok) {
      log.info("api", { method, url, status: res.status, ms: Date.now() - started })
      return (await res.json()) as T
    }
    const raw = await text(res)
    const response = cut(res, raw, 4000, `${method} ${url}`)
    const detail = (await Promise.resolve()
      .then(() => JSON.parse(raw))
      .catch(() => undefined)) as { message?: string; errors?: { message?: string }[] } | undefined
    const message = detail?.errors?.[0]?.message || detail?.message || res.statusText
    log.error("api rejected", {
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

  export async function create(dir: string, input: { name: string; locale?: Locale.Value }) {
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

  export async function select(dir: string, input: { owner: string; name: string; locale?: Locale.Value }) {
    if (!ServeTargets.isProject(dir)) throw new Failure("disabled", 409)
    await rails("/repository", { method: "PUT", body: { repo_owner: input.owner, repo_name: input.name } })
    await firstPush(dir, await linked(), input.locale)
    return status(dir)
  }

  /**
   * 저장소를 만들자마자 지금 작업 폴더를 한 번 올린다. 마지막 기록 뒤에 바뀐 파일이 있으면 먼저 기록에 남긴다. AI 가
   * 답하는 중이면 고치다 만 파일을 남기지 않도록 마지막 기록을 올리고, 나머지는 그 턴이 끝날 때 올라간다.
   * 끝내 실패해도 저장소 생성은 성공으로 두고, 사유를 상태에 남겨 다음 대화가 끝날 때 다시 올린다.
   */
  async function firstPush(dir: string, hit: Link, locale?: Locale.Value) {
    const subject = TurnSummary.first(locale)
    await snapshot(dir, subject)
    const started = Date.now()
    for (let attempt = 1; ; attempt++) {
      const failure = await push(dir, { locale, subject }, hit).then(
        () => undefined,
        (err) => (err instanceof Failure ? err : new Failure("remote", 502, String(err))),
      )
      if (!failure) return
      log.error("first push failed", { attempt, error: lean(failure) })
      if (!transient.includes(failure.code) || attempt >= attempts || Date.now() - started > budget) {
        if (notify.includes(failure.code)) alert("first push gave up", failure, { attempt })
        failed.set(dir, {
          attempts: attempt,
          code: failure.code,
          reason: failure.message.slice(0, detail),
          repo: repoKey(hit.repo),
        })
        return
      }
      await sleep(backoff * attempt)
    }
  }

  async function snapshot(dir: string, subject: string) {
    await WorkspaceRepo.ignore(dir).catch((err) => log.error("gitignore skipped", { error: String(err) }))
    const working = [...(await SessionStatus.list()).values()].some((item) => item.type !== "idle")
    if (working) return
    await History.commit(dir, { message: subject }).catch((err) =>
      log.warn("snapshot failed", { error: err instanceof Error ? err.message : String(err) }),
    )
  }

  /**
   * 충돌 표시의 한쪽만 남긴다. merge-tree 는 `<<<<<<<` 아래에 짓다(ours), `=======` 아래에 GitHub(theirs)를 둔다.
   * diff3 형식이면 `|||||||` 아래 기준 내용은 버린다.
   */
  export function pick(text: string, prefer: Prefer) {
    return text.replace(
      /^<{7}(?: [^\n]*)?\r?\n([\s\S]*?)(?:^\|{7}(?: [^\n]*)?\r?\n[\s\S]*?)?^={7}\r?\n([\s\S]*?)^>{7}(?: [^\n]*)?(?:\r?\n|$)/gm,
      (_, ours: string, theirs: string) => (prefer === "ours" ? ours : theirs),
    )
  }

  const RESOLVE = {
    ko: {
      ours: "충돌을 짓다 기준으로 맞춤",
      theirs: "충돌을 GitHub 기준으로 맞춤",
      backup: "충돌 맞추기 전 자동 저장",
    },
    en: {
      ours: "Resolved the conflict with Jitda's side",
      theirs: "Resolved the conflict with GitHub's side",
      backup: "Saved before resolving the conflict",
    },
    ar: {
      ours: "حُلّ التعارض باعتماد جانب Jitda",
      theirs: "حُلّ التعارض باعتماد جانب GitHub",
      backup: "حُفظ تلقائيًا قبل حل التعارض",
    },
  } as const

  /**
   * GitHub 와 겹친 곳을 팀이 고른 쪽으로 맞추고 올린다. 겹치지 않은 변경은 양쪽 모두 살린다. GitHub 변경을 작업
   * 폴더에 들인 뒤 충돌 표시를 고른 쪽만 남기고, 표시를 남길 수 없는 바이너리는 고른 쪽 파일을 쓴다.
   */
  export async function resolve(dir: string, input: { prefer: Prefer; locale?: Locale.Value }) {
    if (!(await status(dir)).enabled) throw new Failure("disabled", 409)
    if (!(await conflictOf(dir))) throw new Failure("clean", 409)
    if (await working()) throw new Failure("busy", 409)
    const label = RESOLVE[input.locale ?? "ko"]
    const result = await absorb(dir, { backup: label.backup }).catch((err) => {
      if (err instanceof Failure && err.code === "clean") return undefined
      throw err
    })
    if (!result) {
      const pushed = await push(dir, { locale: input.locale, subject: label[input.prefer] })
      return { ...(await status(dir)), pushed: !!pushed.sha }
    }
    const repo = WorkspaceRepo.open(dir)
    const side = input.prefer === "theirs" ? result.theirs : result.ours
    for (const file of result.files) {
      const full = path.join(dir, file)
      const text = await readFile(full, "utf8").catch(() => undefined)
      if (text === undefined) continue
      const picked = pick(text, input.prefer)
      const original = side ? (await repo.run(["cat-file", "blob", `${side}:${file}`])).text() : undefined
      await writeFile(full, original !== undefined && picked === `${original}\n` ? original : picked)
    }
    if (input.prefer === "theirs") {
      for (const file of result.kept) {
        const out = await repo.run(["cat-file", "blob", `${result.theirs}:${file}`])
        if (out.exitCode === 0) await writeFile(path.join(dir, file), out.stdout)
      }
    }
    await History.commit(dir, { message: label[input.prefer] })
    const pushed = await push(dir, { locale: input.locale, subject: label[input.prefer] })
    return { ...(await status(dir)), pushed: !!pushed.sha }
  }

  export async function working(except?: string) {
    return [...(await SessionStatus.list()).entries()].some(([id, item]) => id !== except && item.type !== "idle")
  }

  const PULL = {
    ko: { message: "GitHub에서 바뀐 내용 가져오기", backup: "GitHub 내용 가져오기 전 자동 저장" },
    en: { message: "Brought in changes from GitHub", backup: "Saved before bringing in GitHub changes" },
    ar: { message: "جلب التغييرات من GitHub", backup: "حُفظ تلقائيًا قبل جلب تغييرات GitHub" },
  } as const

  /**
   * GitHub 기본 브랜치에서 마지막으로 맞춘 뒤 바뀐 내용을 작업 폴더로 가져온다. 대화를 시작할 때와 끝나 올리기 전에
   * 부른다. 짓다 변경과 겹치면 건드리지 않고 올리기에서 충돌로 다룬다. 다른 대화가 답하는 중이면 건너뛴다.
   */
  export async function pull(dir: string, input: { locale?: Locale.Value; except?: string; known?: Link } = {}) {
    if (!ServeTargets.isProject(dir)) return
    const hit = input.known ?? (await link())
    if (!hit?.enabled || !hit.connected || !hit.token || !hit.repo) return
    if (await current(dir, remoteOf(hit.repo))) return
    if (await working(input.except)) return
    const repo = WorkspaceRepo.open(dir)
    const lane: Lane = { repo, remote: remoteOf(hit.repo), env: auth(hit.token) }
    return repo.lock(async () => {
      const branch = await defaultBranch(lane)
      const theirs = branch && (await tip(lane, branch))
      if (!branch || !theirs) return
      const base = await baseOf(lane, branch, theirs, hit.push?.sha)
      if (!base || base === theirs) return
      await History.commit(dir, { message: PULL[input.locale ?? "ko"].backup })
      const head = await WorkspaceRepo.rev(repo, WorkspaceRepo.HEAD)
      if (!head) return
      const tree = await publishable(repo, `${head}^{tree}`)
      const merged = await merge(repo, base, theirs, tree)
      if (merged.conflicts.length) return
      const files = (await WorkspaceRepo.diff(repo, tree, merged.tree)).map((change) => change.file)
      if (files.length === 0) {
        await repo.must(["update-ref", baseRef(lane.remote, branch), theirs])
        return
      }
      const source = (
        await repo.must(["commit-tree", "--no-gpg-sign", merged.tree, "-p", theirs, "-m", "jitda"], { env: who })
      ).trim()
      await History.absorb(dir, { source, files, ...PULL[input.locale ?? "ko"] })
      await repo.must(["update-ref", baseRef(lane.remote, branch), theirs])
      log.info("pulled", { files: files.length })
      return files
    }, "github")
  }

  async function defaultBranch(lane: Lane) {
    const out = await lane.repo.run(["ls-remote", "--symref", lane.remote, "HEAD"], { env: lane.env })
    const line = out
      .text()
      .split("\n")
      .find((item) => item.startsWith("ref: "))
    return line?.match(/^ref: refs\/heads\/(\S+)\tHEAD/)?.[1]
  }

  const ABSORB = {
    ko: { message: "GitHub 저장소 내용 가져오기", backup: "GitHub 내용 가져오기 전 자동 저장" },
    en: { message: "Brought in the GitHub repository", backup: "Saved before bringing in GitHub files" },
    ar: { message: "جلب محتوى مستودع GitHub", backup: "حُفظ تلقائيًا قبل جلب ملفات GitHub" },
  } as const

  /** 연결 화면에서 바로 올린다. 마지막 기록 뒤에 바뀐 파일이 있으면 먼저 기록에 남기고, 올릴 것이 없으면 pushed 가 false 다. */
  export async function manual(dir: string, locale?: Locale.Value) {
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
      GIT_CONFIG_KEY_0: `http.${web}/.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
    }
  }

  /** 연결한 팀이면 버전 기록의 최신 커밋을 저장소에 올린다. 연결하지 않은 팀에는 아무것도 하지 않는다. */
  export async function sync(dir: string, locale?: Locale.Value) {
    if (!ServeTargets.isProject(dir)) return
    const hit = await link()
    if (!hit?.enabled || !hit.connected || !hit.token || !hit.repo) return
    const subject = await latest(dir)
    await pull(dir, { locale, known: hit }).catch((err) => log.warn("pull skipped", { error: lean(err) }))
    return push(dir, { locale, subject }, hit)
  }

  async function latest(dir: string) {
    const repo = WorkspaceRepo.open(dir)
    const head = await WorkspaceRepo.rev(repo, WorkspaceRepo.HEAD).catch(() => undefined)
    if (!head) return
    return (await repo.must(["log", "-1", "--format=%s", head])).trim() || undefined
  }

  export async function push(dir: string, input: { locale?: Locale.Value; subject?: string }, known?: Link) {
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
      remote: remoteOf(hit.repo),
      branch: remote.default_branch || "main",
      locale: input.locale,
      subject: input.subject,
      author: {
        name: hit.login || "Jitda",
        email: `${hit.github_user_id ? `${hit.github_user_id}+` : ""}${hit.login}@users.noreply.github.com`,
      },
      env: auth(hit.token!),
      known: hit.push?.sha,
      absorb: async (source, files) => {
        if (await working()) throw new Failure("busy", 409)
        return (await History.absorb(dir, { source, files, ...ABSORB[input.locale ?? "ko"] })).length
      },
    })
    failed.delete(dir)
    if (result.sha) {
      await report({ pushed_sha: result.sha, pushed_by: null }).catch(() => undefined)
      log.info("pushed", { sha: result.sha })
    }
    return { ...result, url: result.sha ? `${hit.repo.url}/commit/${result.sha}` : hit.repo.url }
  }

  function strip(text: string) {
    let clean = text
    for (let previous = ""; previous !== clean; ) {
      previous = clean
      clean = clean.replace(tag, "")
    }
    return clean
  }

  /** 기록 트리에서 짓다 미리보기 브릿지(번들 파일과 HTML 의 script 태그)를 걷어 낸 트리. 학생 저장소에는 이것만 올라간다. */
  async function publishable(repo: WorkspaceRepo.Repo, tree: string) {
    const env = { GIT_INDEX_FILE: path.join(repo.root, "github-index") }
    await repo.must(["read-tree", tree], { env })
    const files = (await repo.must(["ls-files", "-z"], { env })).split("\0").filter(Boolean)
    const bridges = files.filter((file) => path.posix.basename(file) === bridge)
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

  type Lane = { repo: WorkspaceRepo.Repo; remote: string; env?: Record<string, string> }

  /** 원격 브랜치 끝을 받아 온다. 브랜치가 없으면 undefined. */
  async function tip(lane: Lane, branch: string) {
    const ref = `refs/heads/${branch}`
    const heads = await lane.repo.must(["ls-remote", lane.remote, ref], { env: lane.env })
    if (!heads.split("\n").some((line) => line.endsWith(`\t${ref}`))) return
    const track = `refs/remotes/jitda/${branch}`
    await lane.repo.must(["fetch", "--quiet", "--no-tags", "--depth=1", lane.remote, `+${ref}:${track}`], {
      env: lane.env,
    })
    return WorkspaceRepo.rev(lane.repo, track)
  }

  /** 마지막으로 올린 짓다 쪽 트리를 담은 커밋. 다음 올리기에서 원격이 따로 바뀐 부분을 가려내는 기준이다. */
  function baseRef(remote: string, branch: string) {
    return `refs/jitda/github/${Hash.fast(`${remote}\0${branch}`)}`
  }

  async function baseOf(lane: Lane, branch: string, theirs: string, known?: string) {
    const kept = await WorkspaceRepo.rev(lane.repo, baseRef(lane.remote, branch))
    if (kept) return kept
    if (!known) return
    if (known === theirs) return theirs
    const out = await lane.repo.run(["fetch", "--quiet", "--no-tags", "--depth=1", lane.remote, known], {
      env: lane.env,
    })
    if (out.exitCode !== 0) return null
    return WorkspaceRepo.rev(lane.repo, `${known}^{commit}`)
  }

  /**
   * base 에서 갈라진 GitHub 쪽(theirs)과 짓다 쪽(tree)을 합친다. 충돌이 나면 충돌 파일을 돌려준다. `marked` 면 충돌
   * 표시가 든 트리를 함께 돌려준다(AI 로 합치기). 바이너리 충돌은 짓다 쪽을 남긴다.
   */
  const who = {
    GIT_AUTHOR_NAME: "Jitda",
    GIT_AUTHOR_EMAIL: "jitda@localhost",
    GIT_COMMITTER_NAME: "Jitda",
    GIT_COMMITTER_EMAIL: "jitda@localhost",
  }

  async function merge(repo: WorkspaceRepo.Repo, base: string, theirs: string, tree: string) {
    const theirsTree = (await WorkspaceRepo.rev(repo, `${theirs}^{tree}`))!
    const baseTree = (await WorkspaceRepo.rev(repo, `${base}^{tree}`))!
    const commit = async (t: string) =>
      (await repo.must(["commit-tree", "--no-gpg-sign", t, "-p", base, "-m", "jitda"], { env: who })).trim()
    if (baseTree === tree) return { tree: theirsTree, ours: base, conflicts: [] as string[] }
    const ours = await commit(tree)
    if (baseTree === theirsTree) return { tree, ours, conflicts: [] as string[] }
    const out = await repo.run([
      "merge-tree",
      "--write-tree",
      "-z",
      "--name-only",
      "--no-messages",
      ours,
      await commit(theirsTree),
    ])
    if (out.exitCode > 1) throw new Failure("remote", 502, out.stderr.toString().trim())
    const [merged, ...files] = out.text().split("\0").filter(Boolean)
    return { tree: merged!, ours, conflicts: out.exitCode === 1 ? files : [] }
  }

  const marker = /^(<{7}|>{7})( |$)/m

  async function marked(repo: WorkspaceRepo.Repo, tree: string, files: string[]) {
    for (const file of files) {
      const out = await repo.run(["cat-file", "blob", `${tree}:${file}`])
      if (out.exitCode === 0 && marker.test(out.text())) return true
    }
    return false
  }

  const empty = async (repo: WorkspaceRepo.Repo) => {
    const file = path.join(repo.root, "empty-tree")
    await writeFile(file, "")
    const tree = (await repo.must(["hash-object", "-t", "tree", "-w", "--", file])).trim()
    return (await repo.must(["commit-tree", "--no-gpg-sign", tree, "-m", "jitda"], { env: who })).trim()
  }

  export type Absorbed = { files: string[]; kept: string[]; theirs: string; ours?: string }

  /**
   * AI 로 합치기 전 단계. GitHub 쪽 변경을 작업 폴더에 들이고, 양쪽이 같은 곳을 고친 파일에는 충돌 표시를 남긴다.
   * 기준점을 GitHub 끝으로 옮겨 두므로, AI 가 충돌 표시를 정리한 뒤의 올리기는 그 위에 그대로 얹힌다.
   * AI 가 답하지 않는 동안에만 부른다.
   */
  export async function absorb(dir: string, input: { backup: string; marked?: string }): Promise<Absorbed> {
    if (!ServeTargets.isProject(dir)) throw new Failure("disabled", 409)
    if (!(await conflictOf(dir))) throw new Failure("clean", 409)
    const hit = await linked()
    if (!hit.repo) throw new Failure("norepo", 409)
    const conflict = await current(dir, remoteOf(hit.repo))
    if (!conflict) throw new Failure("clean", 409)
    await History.commit(dir, { message: input.backup })
    const repo = WorkspaceRepo.open(dir)
    const lane: Lane = { repo, remote: remoteOf(hit.repo), env: auth(hit.token!) }
    const result = await repo.lock(async () => {
      const theirs = await tip(lane, conflict.target)
      if (!theirs) throw new Failure("clean", 409)
      const head = await WorkspaceRepo.rev(repo, WorkspaceRepo.HEAD)
      if (!head) throw new Failure("empty", 422)
      const tree = await publishable(repo, `${head}^{tree}`)
      const base = (await baseOf(lane, conflict.target, theirs, hit.push?.sha)) || (await empty(repo))
      const merged = await merge(repo, base, theirs, tree)
      if (merged.conflicts.length === 0) throw new Failure("clean", 409)
      const changes = (await WorkspaceRepo.diff(repo, tree, merged.tree)).map((change) => change.file)
      const source = (
        await repo.must(["commit-tree", "--no-gpg-sign", merged.tree, "-p", theirs, "-m", "jitda"], { env: who })
      ).trim()
      await History.absorb(dir, { source, files: changes, message: input.marked ?? input.backup, backup: input.backup })
      await repo.must(["update-ref", baseRef(lane.remote, conflict.target), theirs])
      const kept: string[] = []
      for (const file of merged.conflicts) if (!(await marked(repo, merged.tree, [file]))) kept.push(file)
      const files = merged.conflicts.filter((file) => !kept.includes(file))
      await keep(dir, { ...conflict, files, resolving: true, queued: undefined, owner: undefined })
      log.info("absorbed", { files: files.length, kept: kept.length, changes: changes.length })
      return { files, kept, theirs, ours: merged.ours }
    }, "github")
    return result
  }

  const EMPTY = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

  /** 아직 아무것도 만들지 않은 작업 폴더(짓다가 넣어 둔 .gitignore 만 있음). 이때는 GitHub 내용을 그대로 가져온다. */
  async function blank(repo: WorkspaceRepo.Repo, tree: string) {
    if (tree === EMPTY) return true
    const files = (await repo.must(["ls-tree", "-r", "-z", "--name-only", "--full-tree", tree]))
      .split("\0")
      .filter(Boolean)
    return files.length === 1 && files[0] === ".gitignore"
  }

  function stamp(now = new Date()) {
    return now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)
  }

  /**
   * 버전 기록의 최신 커밋을 원격 브랜치에 올린다. 마지막으로 올린 뒤 GitHub 에서 따로 바뀐 내용이 있으면 3-way 로
   * 합쳐 그 위에 새 커밋으로 얹고, 같은 곳이 양쪽에서 바뀌었으면 기본 브랜치는 그대로 두고 `jitda/<시각>` 브랜치에
   * 올린다. 어떤 경우에도 force-push 하지 않는다. 작업 폴더와 인덱스를 건드리지 않아 기록과 다른 줄에서 돈다.
   */
  export async function publish(input: {
    repo: WorkspaceRepo.Repo
    remote: string
    branch: string
    locale?: Locale.Value
    subject?: string
    author: { name: string; email: string }
    env?: Record<string, string>
    known?: string
    absorb?: (source: string, files?: string[]) => Promise<number>
  }): Promise<Result> {
    const { repo } = input
    const lane: Lane = { repo, remote: input.remote, env: input.env }
    const author = {
      GIT_AUTHOR_NAME: input.author.name,
      GIT_AUTHOR_EMAIL: input.author.email,
      GIT_COMMITTER_NAME: input.author.name,
      GIT_COMMITTER_EMAIL: input.author.email,
    }
    const write = async (tree: string, parent: string | undefined, from: string | undefined, subject: string) => {
      const changes = await WorkspaceRepo.diff(repo, from, tree)
      const message = TurnSummary.compose(subject, changes, input.locale)
      return (
        await repo.must(["commit-tree", "--no-gpg-sign", tree, ...(parent ? ["-p", parent] : []), "-m", message], {
          env: author,
        })
      ).trim()
    }
    const absorb =
      input.absorb ??
      (async (source: string, files?: string[]) =>
        (await History.absorb(repo.dir, { source, files, ...ABSORB[input.locale ?? "ko"] })).length)
    const send = async (sha: string, branch: string) =>
      await repo.run(["push", "--quiet", input.remote, `${sha}:refs/heads/${branch}`], { env: input.env })

    return repo.lock(async () => {
      const head = await WorkspaceRepo.rev(repo, WorkspaceRepo.HEAD)
      const tree = head ? await publishable(repo, `${head}^{tree}`) : EMPTY
      const subject = input.subject ?? (head ? (await repo.must(["log", "-1", "--format=%s", head])).trim() : "")
      const pending = await current(repo.dir, input.remote)
      const settle = async (base: string) => {
        await repo.must(["update-ref", baseRef(input.remote, input.branch), base])
        if (!pending) return
        await keep(repo.dir)
        if (pending.branch.startsWith("jitda/")) {
          const out = await repo.run(["push", "--quiet", input.remote, "--delete", `refs/heads/${pending.branch}`], {
            env: input.env,
          })
          if (out.exitCode !== 0) log.warn("side branch kept", { branch: pending.branch })
        }
        for (const fn of settled) fn(repo.dir)
      }

      const diverged = async (theirs: string, files: string[], retry: boolean, linking?: boolean): Promise<Result> => {
        const branch = pending?.branch ?? `jitda/${stamp()}`
        const top = await tip(lane, branch)
        const parent = top ?? theirs
        const parentTree = (await WorkspaceRepo.rev(repo, `${parent}^{tree}`))!
        const conflict: Conflict = {
          branch,
          target: input.branch,
          files,
          resolving: false,
          remote: input.remote,
          ...(linking || pending?.linking ? { linking: true } : {}),
          ...(pending?.queued ? { queued: pending.queued, owner: pending.owner } : {}),
        }
        const { remote: _, owner: __, ...visible } = conflict
        if (parentTree === tree) {
          await keep(repo.dir, conflict)
          return { conflict: visible }
        }
        const sha = await write(tree, parent, parentTree, subject)
        const out = await send(sha, branch)
        if (out.exitCode !== 0) {
          if (retry) return diverged(theirs, files, false, linking)
          throw new Failure("remote", 502, out.stderr.toString().trim())
        }
        await keep(repo.dir, conflict)
        log.info("diverged", { branch, files: files.length })
        return { conflict: visible }
      }

      const bring = async (target: string, theirs: string, from: string) => {
        const files = (await WorkspaceRepo.diff(repo, from, target)).map((change) => change.file)
        if (files.length === 0) return 0
        const source = (
          await repo.must(["commit-tree", "--no-gpg-sign", target, "-p", theirs, "-m", "jitda"], { env: who })
        ).trim()
        return absorb(source, files).catch((err) => {
          log.warn("absorb skipped", { error: lean(err) })
          return undefined
        })
      }

      const attempt = async (retry: boolean): Promise<Result> => {
        const theirs = await tip(lane, input.branch)
        const again = async (out: { exitCode: number; stderr: Buffer }) => {
          if (retry) return attempt(false)
          throw new Failure("remote", 502, out.stderr.toString().trim())
        }
        if (!theirs) {
          if (tree === EMPTY) throw new Failure("empty", 422)
          const sha = await write(tree, undefined, undefined, subject)
          const out = await send(sha, input.branch)
          if (out.exitCode !== 0) return again(out)
          await settle(sha)
          return { sha }
        }
        const theirsTree = (await WorkspaceRepo.rev(repo, `${theirs}^{tree}`))!
        const base = await baseOf(lane, input.branch, theirs, input.known)
        if (base === undefined) {
          if (tree === theirsTree) {
            await settle(theirs)
            return {}
          }
          if (await blank(repo, tree)) {
            const absorbed = await absorb(theirs)
            await settle(theirs)
            return { absorbed }
          }
          const linked = await merge(repo, await empty(repo), theirs, tree)
          if (linked.conflicts.length > 0) return diverged(theirs, linked.conflicts, true, true)
          const pulled = (await WorkspaceRepo.diff(repo, tree, linked.tree)).map((change) => change.file)
          const source = (
            await repo.must(["commit-tree", "--no-gpg-sign", linked.tree, "-p", theirs, "-m", "jitda"], { env: who })
          ).trim()
          const absorbed = pulled.length ? await absorb(source, pulled) : 0
          if (linked.tree === theirsTree) {
            await settle(theirs)
            return { absorbed }
          }
          const sha = await write(linked.tree, theirs, theirsTree, subject)
          const out = await send(sha, input.branch)
          if (out.exitCode !== 0) return again(out)
          await settle(sha)
          return { sha, absorbed }
        }
        if (base === null) {
          const files = (await WorkspaceRepo.diff(repo, theirsTree, tree)).map((change) => change.file)
          if (files.length === 0) {
            await settle(theirs)
            return {}
          }
          return diverged(theirs, files, true)
        }
        const merged = await merge(repo, base, theirs, tree)
        if (merged.conflicts.length > 0) return diverged(theirs, merged.conflicts, true)
        if (pending?.resolving && (await marked(repo, merged.tree, pending.files))) {
          return diverged(theirs, pending.files, true)
        }
        const taken = await bring(merged.tree, theirs, tree)
        if (merged.tree === theirsTree) {
          await settle(taken === undefined ? merged.ours : theirs)
          return taken ? { absorbed: taken } : {}
        }
        const sha = await write(merged.tree, theirs, theirsTree, subject)
        const out = await send(sha, input.branch)
        if (out.exitCode !== 0) return again(out)
        await settle(merged.tree === tree || taken !== undefined ? sha : merged.ours)
        return taken ? { sha, absorbed: taken } : { sha }
      }
      return attempt(true)
    }, "github")
  }
}
