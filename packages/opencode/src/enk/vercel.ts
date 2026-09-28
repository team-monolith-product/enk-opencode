import type { Dirent } from "fs"
import { readdir, readFile, stat } from "fs/promises"
import path from "path"
import { EnvFile } from "../util/env-file"
import { Hash } from "../util/hash"
import { Log } from "../util/log"
import { GitHub } from "./github"
import { ServeTargets } from "./serve-targets"

export namespace Vercel {
  const log = Log.create({ service: "vercel" })
  const api = "https://api.vercel.com"
  const route = "/api/v1/opencode/vercel"
  const BACKEND = new Set<Framework>(["express", "hono", "fastify", "flask", "fastapi"])
  const PUBLIC = /^(VITE_|NEXT_PUBLIC_|NUXT_PUBLIC_|REACT_APP_|PUBLIC_|EXPO_PUBLIC_)/
  const ENTRY = ["app", "index", "server"].flatMap((name) =>
    ["js", "cjs", "mjs", "ts", "cts", "mts"].flatMap((ext) => [`${name}.${ext}`, `src/${name}.${ext}`]),
  )
  const SKIP = new Set(["node_modules", "dist", "build", "out", "public", "static", "assets"])

  export type Framework =
    | "nextjs"
    | "nuxtjs"
    | "sveltekit"
    | "astro"
    | "vite"
    | "create-react-app"
    | "express"
    | "hono"
    | "fastify"
    | "flask"
    | "fastapi"
    | null
  export type Layout = { root: string; framework: Framework }
  export type Project = { id: string; name: string; url?: string }
  export type Deployment = { state: string; url?: string; time: number; blocked?: string }
  export type Status = {
    enabled: boolean
    connectUrl?: string
    username?: string
    linkedBy?: string
    project?: Project
    deployment?: Deployment
    backend?: boolean
    exposed?: string[]
  }
  export type Code = "disabled" | "unlinked" | "norepo" | "repo" | "revoked" | "missing" | "remote"

  type Link = {
    enabled: boolean
    connected: boolean
    connect_url?: string
    username?: string
    linked_by?: string
    token?: string
    team_id?: string | null
    configuration_id?: string
    project?: { id: string; name: string; url?: string | null }
  }
  type Remote = {
    id: string
    name: string
    link?: { type?: string; org?: string; repo?: string; productionBranch?: string }
    alias?: { domain: string; target?: string }[]
  }
  type Env = { key: string; value: string }

  export class Failure extends Error {
    constructor(
      readonly code: Code,
      readonly status: 404 | 409 | 502,
      message?: string,
    ) {
      super(message || code)
      this.name = "VercelFailure"
    }
  }

  const synced = new Map<string, string>()

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
    if (!hit?.enabled) throw new Failure("disabled", 409)
    if (!hit.connected || !hit.token) throw new Failure("unlinked", 409)
    return hit
  }

  async function request<T>(hit: Link, method: string, target: string, body?: unknown): Promise<T> {
    const url = new URL(target, api)
    if (hit.team_id) url.searchParams.set("teamId", hit.team_id)
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${hit.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    }).catch((err) => {
      throw new Failure("remote", 502, String(err))
    })
    if (res.ok) return (await res.json().catch(() => undefined)) as T
    const detail = (await res.json().catch(() => undefined)) as
      | { error?: { message?: string; invalidToken?: boolean } }
      | undefined
    const message = detail?.error?.message || res.statusText
    if (res.status === 401 || detail?.error?.invalidToken) {
      await report({ revoked: true }).catch(() => undefined)
      throw new Failure("revoked", 409, message)
    }
    if (res.status === 404) throw new Failure("missing", 404, message)
    throw new Failure("remote", 502, message)
  }

  async function exists(file: string) {
    return stat(file).then(
      (info) => info.isFile(),
      () => false,
    )
  }

  async function text(file: string) {
    return readFile(file, "utf8").catch(() => "")
  }

  export async function detect(dir: string): Promise<Framework | undefined> {
    const pkg = await text(path.join(dir, "package.json"))
    if (pkg) {
      const json = (() => {
        try {
          return JSON.parse(pkg) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
        } catch {
          return {}
        }
      })()
      const deps = { ...json.dependencies, ...json.devDependencies }
      if (deps["next"]) return "nextjs"
      if (deps["nuxt"]) return "nuxtjs"
      if (deps["@sveltejs/kit"]) return "sveltekit"
      if (deps["astro"]) return "astro"
      if (deps["express"] && (await Promise.all(ENTRY.map((file) => exists(path.join(dir, file))))).some(Boolean))
        return "express"
      if (deps["hono"]) return "hono"
      if (deps["fastify"]) return "fastify"
      if (deps["vite"]) return "vite"
      if (deps["react-scripts"]) return "create-react-app"
      return null
    }
    const python = (await text(path.join(dir, "requirements.txt"))) + (await text(path.join(dir, "pyproject.toml")))
    if (/\bfastapi\b/i.test(python)) return "fastapi"
    if (/\bflask\b/i.test(python)) return "flask"
    if (await exists(path.join(dir, "index.html"))) return null
    return undefined
  }

  export async function layout(dir: string): Promise<Layout> {
    const here = await detect(dir)
    if (here !== undefined) return { root: "", framework: here }
    const names = (await readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[]))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIP.has(entry.name))
      .map((entry) => entry.name)
      .sort()
    const found = (
      await Promise.all(names.map(async (name) => ({ root: name, framework: await detect(path.join(dir, name)) })))
    ).filter((item): item is Layout => item.framework !== undefined)
    return found.find((item) => item.framework !== null) ?? found[0] ?? { root: "", framework: null }
  }

  async function entries(dir: string): Promise<Env[]> {
    return Object.entries(await EnvFile.load(dir))
      .filter(([, value]) => value !== "")
      .map(([key, value]) => ({ key, value }))
  }

  async function upload(hit: Link, id: string, env: Env[]) {
    if (env.length > 0) {
      await request(
        hit,
        "POST",
        `/v10/projects/${encodeURIComponent(id)}/env?upsert=true`,
        env.map((item) => ({ ...item, type: "encrypted", target: ["production", "preview"] })),
      )
    }
    const current = await request<{ envs?: { id: string; key: string; configurationId?: string | null }[] }>(
      hit,
      "GET",
      `/v10/projects/${encodeURIComponent(id)}/env`,
    )
    const keep = new Set(env.map((item) => item.key))
    await Promise.all(
      (current?.envs ?? [])
        .filter((item) => item.configurationId === hit.configuration_id && !keep.has(item.key))
        .map((item) =>
          request(hit, "DELETE", `/v9/projects/${encodeURIComponent(id)}/env/${encodeURIComponent(item.id)}`),
        ),
    )
  }

  export async function sync(dir: string) {
    if (!serves(dir)) return
    const hit = await link()
    if (!hit?.connected || !hit.token || !hit.project) return
    const env = await entries(dir)
    const key = `${hit.project.id}:${Hash.fast(JSON.stringify(env))}`
    if (synced.get(dir) === key) return
    await upload(hit, hit.project.id, env)
    synced.set(dir, key)
  }

  function slug(name: string) {
    const clean = name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-{3,}/g, "--")
      .replace(/^[-._]+|[-._]+$/g, "")
      .slice(0, 90)
    return clean || "jitda-app"
  }

  async function lookup(hit: Link, name: string) {
    return request<Remote>(hit, "GET", `/v9/projects/${encodeURIComponent(name)}`).catch((err) => {
      if (err instanceof Failure && err.code === "missing") return undefined
      throw err
    })
  }

  async function claim(hit: Link, repo: GitHub.Repo): Promise<{ name: string; existing?: Remote }> {
    const base = slug(repo.name)
    for (const name of [base, `${base}-jitda`]) {
      const found = await lookup(hit, name)
      if (!found) return { name }
      if (found.link?.type === "github" && found.link.org === repo.owner && found.link.repo === repo.name)
        return { name, existing: found }
    }
    return { name: `${base}-${Math.random().toString(36).slice(2, 6)}` }
  }

  export async function create(dir: string) {
    if (!serves(dir)) throw new Failure("disabled", 409)
    const hit = await linked()
    if (hit.project) return status(dir)
    const repo = (await GitHub.status(dir)).repo
    if (!repo) throw new Failure("norepo", 409)
    const { root, framework } = await layout(dir)
    const target = await claim(hit, repo)
    const project =
      target.existing ??
      (await request<Remote>(hit, "POST", "/v11/projects", {
        name: target.name,
        framework,
        rootDirectory: root || null,
        gitRepository: { type: "github", repo: `${repo.owner}/${repo.name}` },
      }).catch((err) => {
        if (err instanceof Failure && (err.code === "remote" || err.code === "missing"))
          throw new Failure("repo", 409, err.message)
        throw err
      }))
    await report({ project_id: project.id, project_name: project.name })
    const env = await entries(dir)
    await upload(hit, project.id, env)
    synced.set(dir, `${project.id}:${Hash.fast(JSON.stringify(env))}`)
    await request(hit, "POST", "/v13/deployments", {
      name: project.name,
      project: project.id,
      target: "production",
      gitSource: { type: "github", org: repo.owner, repo: repo.name, ref: project.link?.productionBranch || "main" },
    }).catch((err) => log.warn("first deploy skipped", { error: err instanceof Error ? err.message : String(err) }))
    return status(dir)
  }

  async function latest(hit: Link, id: string): Promise<Deployment | undefined> {
    const out = await request<{
      deployments?: {
        url?: string | null
        readyState?: string
        state?: string
        created?: number
        createdAt?: number
        seatBlock?: { blockCode?: string }
      }[]
    }>(hit, "GET", `/v7/deployments?projectId=${encodeURIComponent(id)}&target=production&limit=1`)
    const item = out?.deployments?.[0]
    if (!item) return
    return {
      state: item.readyState || item.state || "QUEUED",
      url: item.url ? `https://${item.url}` : undefined,
      time: item.createdAt ?? item.created ?? Date.now(),
      blocked: item.seatBlock?.blockCode,
    }
  }

  async function production(hit: Link, id: string) {
    const project = await request<Remote>(hit, "GET", `/v9/projects/${encodeURIComponent(id)}`)
    const domain = project?.alias?.find((item) => item.target === "PRODUCTION")?.domain
    return domain ? `https://${domain}` : undefined
  }

  export async function status(dir: string): Promise<Status> {
    if (!serves(dir)) return { enabled: false }
    const hit = await link()
    if (!hit?.enabled) return { enabled: false }
    const connected = hit.connected && !!hit.token
    const project = hit.project
      ? { id: hit.project.id, name: hit.project.name, url: hit.project.url ?? undefined }
      : undefined
    const base: Status = {
      enabled: true,
      connectUrl: hit.connect_url,
      username: connected ? hit.username : undefined,
      linkedBy: connected ? hit.linked_by : undefined,
      project,
    }
    if (!connected || !project) return base
    const live = await Promise.all([latest(hit, project.id), production(hit, project.id)]).catch((err) => {
      if (err instanceof Failure && err.code === "revoked") return "revoked" as const
      log.warn("status failed", { error: err instanceof Error ? err.message : String(err) })
      return undefined
    })
    if (live === "revoked") return { ...base, username: undefined, linkedBy: undefined }
    const [deployment, site] = live ?? []
    if (site && site !== project.url) await report({ site_url: site }).catch(() => undefined)
    const { framework } = await layout(dir)
    return {
      ...base,
      project: { ...project, url: site ?? project.url },
      deployment,
      backend: framework !== null && BACKEND.has(framework),
      exposed: Object.keys(await EnvFile.load(dir)).filter((key) => PUBLIC.test(key)),
    }
  }
}
