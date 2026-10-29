import { writeFile } from "fs/promises"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import path from "path"
import { setTimeout as sleep } from "node:timers/promises"
import { errorData } from "../util/error"
import { Log } from "../util/log"
import { SentryReporter } from "../util/sentry"
import { EnkFailure } from "./failure"
import { SessionStatus } from "../session/status"
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
    login?: string
    linkedBy?: string
    repo?: Repo
    push?: Push
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
    | "missing"
    | "empty"
    | "remote"

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

  const failed = new Map<string, FirstPush>()

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

  async function linked() {
    const hit = await link()
    if (!hit?.connected || !hit.token) throw new Failure("unlinked", 409)
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
      login: hit.connected ? hit.login : undefined,
      linkedBy: hit.connected ? hit.linked_by : undefined,
      repo: hit.repo,
      push: hit.push ? { sha: hit.push.sha, time: hit.push.at, by: hit.push.by } : undefined,
      firstPush: failed.get(dir),
    }
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
    const repo = shape(
      await request<Remote>(hit.token!, "POST", "/user/repos", { name: input.name, private: false, auto_init: false }),
    )
    await report({ repo_owner: repo.owner, repo_name: repo.name, repo_url: repo.url })
    await firstPush(dir, { ...hit, repo }, input.locale)
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
        failed.set(dir, { attempts: attempt, code: failure.code, reason: failure.message.slice(0, detail) })
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
    await push(dir, { locale }, hit)
  }

  export async function push(dir: string, input: { locale?: Locale.Value; subject?: string }, known?: Link) {
    const hit = known ?? (await linked())
    if (!hit.repo) throw new Failure("norepo", 409)
    const remote = await request<Remote>(
      hit.token!,
      "GET",
      `/repos/${encodeURIComponent(hit.repo.owner)}/${encodeURIComponent(hit.repo.name)}`,
    )
    if (remote.permissions?.push === false) throw new Failure("forbidden", 409)
    const result = await publish({
      repo: WorkspaceRepo.open(dir),
      remote: `${web}/${hit.repo.owner}/${hit.repo.name}.git`,
      branch: remote.default_branch || "main",
      locale: input.locale,
      subject: input.subject,
      author: {
        name: hit.login || "Jitda",
        email: `${hit.github_user_id ? `${hit.github_user_id}+` : ""}${hit.login}@users.noreply.github.com`,
      },
      env: auth(hit.token!),
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

  /**
   * 버전 기록의 최신 커밋을 원격 브랜치 위에 새 커밋으로 올린다. 원격에서 따로 쌓인 커밋(GitHub 웹 편집 등)이
   * 있으면 그 위에 얹으므로 force-push 하지 않는다. 작업 폴더와 인덱스를 건드리지 않아 기록과 다른 줄에서 돈다.
   * 메시지는 기록 커밋의 제목에 원격과 달라진 파일 목록을 붙인다. 누가 먼저 올리든 같은 메시지가 된다.
   */
  export async function publish(input: {
    repo: WorkspaceRepo.Repo
    remote: string
    branch: string
    locale?: Locale.Value
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
        throw new Failure("remote", 502, out.stderr.toString().trim())
      }
      return attempt(true)
    }, "github")
  }
}
