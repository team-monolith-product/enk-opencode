import { afterEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { mkdir, writeFile } from "fs/promises"
import { Vercel } from "../../src/enk/vercel"
import { VercelRoutes } from "../../src/server/routes/vercel"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
  delete process.env["ENK_HACKATHON_RAILS_URL"]
  delete process.env["ENK_AI_USAGE_TOKEN"]
  delete process.env["ENK_PROJECT_DIRECTORY"]
})

const linked = {
  enabled: true,
  connected: true,
  username: "student",
  linked_by: "홍길동",
  token: "vc_1",
  team_id: null,
  configuration_id: "icfg_1",
}

function serve(links: { vercel: Record<string, unknown>; github?: Record<string, unknown> }) {
  const reports: unknown[] = []
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const vercel = new URL(req.url).pathname.endsWith("/vercel")
      if (req.method === "PUT") reports.push(await req.json())
      return Response.json(vercel ? links.vercel : (links.github ?? { enabled: false }))
    },
  })
  process.env["ENK_HACKATHON_RAILS_URL"] = server.url.origin
  process.env["ENK_AI_USAGE_TOKEN"] = "team-token"
  return { reports, [Symbol.asyncDispose]: () => server.stop(true) }
}

type Call = { method: string; url: URL; body?: unknown }

function vercel(route: (call: Call) => Response | undefined) {
  const calls: Call[] = []
  const original = globalThis.fetch
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.host !== "api.vercel.com") return original(input, init)
    const call = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(call)
    return route(call) ?? Response.json({ error: { message: "not found" } }, { status: 404 })
  }) as typeof fetch)
  return { calls, [Symbol.dispose]: () => spy.mockRestore() }
}

async function put(root: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await writeFile(path.join(root, name), text)
  }
}

describe("Vercel.layout", () => {
  test("a static site at the root deploys the root as is", async () => {
    await using tmp = await tmpdir()
    await put(tmp.path, { "index.html": "<h1>hi</h1>" })

    expect(await Vercel.layout(tmp.path)).toEqual({ root: "", framework: null })
  })

  test("create-next-app output in a subfolder becomes the root directory", async () => {
    await using tmp = await tmpdir()
    await put(tmp.path, {
      "notes.md": "plan",
      "node_modules/next/package.json": "{}",
      "my-app/package.json": JSON.stringify({ dependencies: { next: "16.0.0", react: "19.0.0" } }),
    })

    expect(await Vercel.layout(tmp.path)).toEqual({ root: "my-app", framework: "nextjs" })
  })

  test("express counts only when it has an entry vercel can find", async () => {
    await using tmp = await tmpdir()
    await put(tmp.path, { "package.json": JSON.stringify({ dependencies: { express: "5.1.0" } }) })
    expect(await Vercel.layout(tmp.path)).toEqual({ root: "", framework: null })

    await put(tmp.path, { "server.js": "require('express')().listen(3000)" })
    expect(await Vercel.layout(tmp.path)).toEqual({ root: "", framework: "express" })
  })

  test("python servers are read from requirements", async () => {
    await using tmp = await tmpdir()
    await put(tmp.path, { "requirements.txt": "Flask==3.1.0\n" })

    expect(await Vercel.layout(tmp.path)).toEqual({ root: "", framework: "flask" })
  })
})

describe("Vercel.status", () => {
  test("stays off when the hackathon backend is not configured", async () => {
    await using tmp = await tmpdir()

    expect(await Vercel.status(tmp.path)).toEqual({ enabled: false })
  })

  test("shows the latest production deployment and remembers the site", async () => {
    await using tmp = await tmpdir()
    await put(tmp.path, { "index.html": "<h1>hi</h1>", ".env": "VITE_KEY=abc\nSECRET_KEY=def\n" })
    await using rails = serve({ vercel: { ...linked, project: { id: "prj_1", name: "jitda-app", url: null } } })
    using api = vercel((call) => {
      if (call.url.pathname === "/v7/deployments")
        return Response.json({
          deployments: [{ url: "jitda-app-abc.vercel.app", readyState: "READY", createdAt: 1_700_000_000_000 }],
        })
      if (call.url.pathname === "/v9/projects/prj_1")
        return Response.json({
          id: "prj_1",
          name: "jitda-app",
          alias: [{ domain: "jitda-app.vercel.app", target: "PRODUCTION" }],
        })
    })

    const status = await Vercel.status(tmp.path)

    expect(status).toMatchObject({
      enabled: true,
      username: "student",
      project: { id: "prj_1", url: "https://jitda-app.vercel.app" },
      deployment: { state: "READY", url: "https://jitda-app-abc.vercel.app" },
      backend: false,
      exposed: ["VITE_KEY"],
    })
    expect(rails.reports).toEqual([{ site_url: "https://jitda-app.vercel.app" }])
    expect(api.calls.find((call) => call.url.pathname === "/v7/deployments")?.url.searchParams.get("target")).toBe(
      "production",
    )
  })

  test("a token Vercel rejects is dropped so the team can connect again", async () => {
    await using tmp = await tmpdir()
    await using rails = serve({ vercel: { ...linked, project: { id: "prj_1", name: "jitda-app" } } })
    using _api = vercel(() =>
      Response.json({ error: { message: "Not authorized", invalidToken: true } }, { status: 403 }),
    )

    const status = await Vercel.status(tmp.path)

    expect(status.username).toBeUndefined()
    expect(rails.reports).toContainEqual({ revoked: true })
  })
})

describe("Vercel.create", () => {
  test("importing needs the GitHub repository first", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve({
      vercel: linked,
      github: { enabled: true, connected: true, login: "octocat", token: "gho_1" },
    })

    await expect(Vercel.create(tmp.path)).rejects.toMatchObject({ code: "norepo" })
  })

  test("imports the repository, copies env values and starts the first deployment", async () => {
    await using tmp = await tmpdir()
    await put(tmp.path, {
      ".env": "OPENAI_API_KEY=sk-1\nEMPTY_KEY=\n",
      "my-app/package.json": JSON.stringify({ dependencies: { next: "16.0.0" } }),
    })
    await using rails = serve({
      vercel: linked,
      github: {
        enabled: true,
        connected: true,
        login: "octocat",
        token: "gho_1",
        repo: { owner: "octocat", name: "Jitda.App", url: "https://github.com/octocat/Jitda.App" },
      },
    })
    using api = vercel((call) => {
      if (call.method === "POST" && call.url.pathname === "/v11/projects")
        return Response.json({ id: "prj_1", name: "jitda.app", link: { type: "github", productionBranch: "main" } })
      if (call.method === "GET" && call.url.pathname === "/v10/projects/prj_1/env")
        return Response.json({
          envs: [
            { id: "env_old", key: "OLD_KEY", configurationId: "icfg_1" },
            { id: "env_mine", key: "MY_OWN", configurationId: null },
          ],
        })
      if (
        call.url.pathname.startsWith("/v10/projects/prj_1/env") ||
        call.url.pathname.startsWith("/v9/projects/prj_1/env")
      )
        return Response.json({ created: [], failed: [] })
      if (call.url.pathname === "/v13/deployments") return Response.json({ id: "dpl_1" })
    })

    await Vercel.create(tmp.path)

    const project = api.calls.find((call) => call.url.pathname === "/v11/projects")
    expect(project?.body).toEqual({
      name: "jitda.app",
      framework: "nextjs",
      rootDirectory: "my-app",
      gitRepository: { type: "github", repo: "octocat/Jitda.App" },
    })
    const env = api.calls.find((call) => call.method === "POST" && call.url.pathname === "/v10/projects/prj_1/env")
    expect(env?.url.searchParams.get("upsert")).toBe("true")
    expect(env?.body).toEqual([
      { key: "OPENAI_API_KEY", value: "sk-1", type: "encrypted", target: ["production", "preview"] },
    ])
    expect(api.calls.filter((call) => call.method === "DELETE").map((call) => call.url.pathname)).toEqual([
      "/v9/projects/prj_1/env/env_old",
    ])
    expect(api.calls.find((call) => call.url.pathname === "/v13/deployments")?.body).toMatchObject({
      project: "prj_1",
      target: "production",
      gitSource: { type: "github", org: "octocat", repo: "Jitda.App", ref: "main" },
    })
    expect(rails.reports).toContainEqual({ project_id: "prj_1", project_name: "jitda.app" })
  })

  test("an existing project for the same repository is reused", async () => {
    await using tmp = await tmpdir()
    await put(tmp.path, { "index.html": "<h1>hi</h1>" })
    await using rails = serve({
      vercel: linked,
      github: {
        enabled: true,
        connected: true,
        login: "octocat",
        token: "gho_1",
        repo: { owner: "octocat", name: "jitda-app", url: "https://github.com/octocat/jitda-app" },
      },
    })
    using api = vercel((call) => {
      if (call.method === "GET" && call.url.pathname === "/v9/projects/jitda-app")
        return Response.json({
          id: "prj_9",
          name: "jitda-app",
          link: { type: "github", org: "octocat", repo: "jitda-app" },
        })
      if (call.url.pathname.includes("/env")) return Response.json({ envs: [] })
      if (call.url.pathname === "/v13/deployments") return Response.json({ id: "dpl_1" })
    })

    await Vercel.create(tmp.path)

    expect(api.calls.some((call) => call.url.pathname === "/v11/projects")).toBe(false)
    expect(rails.reports).toContainEqual({ project_id: "prj_9", project_name: "jitda-app" })
  })

  test("a repository Vercel cannot reach asks for GitHub access", async () => {
    await using tmp = await tmpdir()
    await put(tmp.path, { "index.html": "<h1>hi</h1>" })
    await using _rails = serve({
      vercel: linked,
      github: {
        enabled: true,
        connected: true,
        login: "octocat",
        token: "gho_1",
        repo: { owner: "octocat", name: "jitda-app", url: "https://github.com/octocat/jitda-app" },
      },
    })
    using _api = vercel((call) => {
      if (call.method === "POST" && call.url.pathname === "/v11/projects")
        return Response.json({ error: { message: "Repository not found" } }, { status: 400 })
    })

    await expect(Vercel.create(tmp.path)).rejects.toMatchObject({ code: "repo", message: "Repository not found" })
  })
})

describe("Vercel.sync", () => {
  test("env values are sent again only after they change", async () => {
    await using tmp = await tmpdir()
    await put(tmp.path, { ".env": "OPENAI_API_KEY=sk-1\n" })
    await using _rails = serve({ vercel: { ...linked, project: { id: "prj_1", name: "jitda-app" } } })
    using api = vercel((call) => (call.method === "GET" ? Response.json({ envs: [] }) : Response.json({ failed: [] })))

    await Vercel.sync(tmp.path)
    await Vercel.sync(tmp.path)
    expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(1)

    await put(tmp.path, { ".env": "OPENAI_API_KEY=sk-2\n" })
    await Vercel.sync(tmp.path)
    expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(2)
  })
})

describe("VercelRoutes", () => {
  test("status hides the feature until the backend is configured", async () => {
    await using tmp = await tmpdir()

    const res = await Instance.provide({
      directory: tmp.path,
      fn: () => VercelRoutes().request("/", { method: "GET" }),
    })

    expect(await res.json()).toEqual({ enabled: false })
  })
})
