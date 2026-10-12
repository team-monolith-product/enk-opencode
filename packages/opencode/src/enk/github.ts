import { writeFile } from "fs/promises"
import path from "path"
import { Log } from "../util/log"
import { EnkFailure } from "./failure"
import { Rails } from "./rails"
import { ServeTargets } from "./serve-targets"
import { WorkspaceRepo } from "./workspace-repo"

export namespace GitHub {
  const log = Log.create({ service: "github" })
  const web = "https://github.com"
  const api = "https://api.github.com"
  const agent = "jitda-opencode"
  const route = "/api/v1/opencode/github"
  const bridge = "__preview-bridge.js"
  const tag = /[ \t]*<script\b[^>]*\bdata-preview-bridge\b[^>]*>\s*<\/script>[ \t]*(\r?\n)?/gi

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
  export type Result = { sha?: string }
  export type Describe = (changes: WorkspaceRepo.Change[]) => Promise<string>
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

  export class Failure extends EnkFailure<Code> {}

  async function link(): Promise<Link | undefined> {
    const rails = Rails.endpoint(route)
    if (!rails) return
    const res = await fetch(rails.url, { headers: rails.headers, signal: AbortSignal.timeout(15_000) }).catch(
      () => undefined,
    )
    if (!res?.ok) return
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
    }).catch(() => undefined)
    if (!res?.ok) throw new Failure("remote", 502)
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

  /** 연결한 팀이면 버전 기록의 최신 커밋을 저장소에 올린다. 연결하지 않은 팀에는 아무것도 하지 않는다. */
  export async function sync(dir: string, message: string | Describe) {
    const current = await status(dir)
    if (!current.login || !current.repo) return
    await push(dir, { message })
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
    const result = await publish({
      repo: WorkspaceRepo.open(dir),
      remote: `${web}/${hit.repo.owner}/${hit.repo.name}.git`,
      branch: remote.default_branch || "main",
      message: input.message,
      author: {
        name: hit.login || "Jitda",
        email: `${hit.github_user_id ? `${hit.github_user_id}+` : ""}${hit.login}@users.noreply.github.com`,
      },
      env: auth(hit.token!),
    })
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
   */
  export async function publish(input: {
    repo: WorkspaceRepo.Repo
    remote: string
    branch: string
    message: string | Describe
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
      let message: string | undefined
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
        message ??=
          typeof input.message === "string"
            ? input.message
            : await input.message(await WorkspaceRepo.diff(repo, parent && `${parent}^{tree}`, tree))
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
