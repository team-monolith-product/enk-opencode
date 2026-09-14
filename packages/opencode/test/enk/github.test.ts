import { afterEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import path from "path"
import { mkdir, rm, truncate, writeFile } from "fs/promises"
import { GitHub } from "../../src/enk/github"
import { GitHubRoutes } from "../../src/server/routes/github"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const author = { name: "홍길동", email: "1+hong@users.noreply.github.com" }

afterEach(async () => {
  await Instance.disposeAll()
  delete process.env["ENK_HACKATHON_RAILS_URL"]
  delete process.env["ENK_AI_USAGE_TOKEN"]
  delete process.env["ENK_PROJECT_DIRECTORY"]
})

/** 팀 pod 가 이야기하는 hackathon-rails 역할. 실제 HTTP 를 그대로 태운다. */
function serve(link: Record<string, unknown>) {
  const server = Bun.serve({ port: 0, fetch: () => Response.json(link) })
  process.env["ENK_HACKATHON_RAILS_URL"] = server.url.origin
  process.env["ENK_AI_USAGE_TOKEN"] = "team-token"
  return { server, [Symbol.asyncDispose]: () => server.stop(true) }
}

async function workspace(root: string) {
  const work = path.join(root, "project-directory")
  const remote = path.join(root, "remote.git")
  const gitdir = path.join(root, "gitdir")
  await mkdir(path.join(work, ".git"), { recursive: true })
  await writeFile(path.join(work, ".git", "opencode"), "team-1-project")
  await $`git init --quiet --bare ${remote}`.quiet()
  return {
    work,
    remote,
    publish: (message: string) => GitHub.publish({ gitdir, worktree: work, remote, branch: "main", message, author }),
    files: () =>
      $`git --git-dir=${remote} ls-tree -r --name-only main`
        .quiet()
        .text()
        .then((text) => text.split("\n").filter(Boolean).sort()),
    log: () =>
      $`git --git-dir=${remote} log --format=%s main`
        .quiet()
        .text()
        .then((text) => text.split("\n").filter(Boolean)),
  }
}

async function put(root: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await writeFile(path.join(root, name), text)
  }
}

describe("GitHub.publish", () => {
  test("first push leaves out secrets, dependencies and the opencode marker", async () => {
    await using tmp = await tmpdir()
    const ws = await workspace(tmp.path)
    await put(ws.work, {
      "index.html": "<h1>hi</h1>",
      "src/app.js": "console.log(1)",
      ".env": "API_KEY=secret",
      ".env.local": "API_KEY=secret",
      ".env.example": "API_KEY=",
      ".gitignore": "!.env\n",
      "node_modules/pkg/index.js": "module.exports = 1",
    })

    const result = await ws.publish("first")

    expect(result.sha).toBeDefined()
    expect(result.skipped).toEqual([])
    expect(await ws.files()).toEqual([".env.example", ".gitignore", "index.html", "src/app.js"])
    expect((await $`git --git-dir=${ws.remote} log -1 --format=%an/%ae main`.quiet().text()).trim()).toBe(
      `${author.name}/${author.email}`,
    )
  })

  test("an unchanged workspace pushes nothing", async () => {
    await using tmp = await tmpdir()
    const ws = await workspace(tmp.path)
    await put(ws.work, { "index.html": "a" })
    await ws.publish("first")

    const result = await ws.publish("again")

    expect(result.sha).toBeUndefined()
    expect(await ws.log()).toEqual(["first"])
  })

  test("the next push fast-forwards the branch with edits and deletions", async () => {
    await using tmp = await tmpdir()
    const ws = await workspace(tmp.path)
    await put(ws.work, { "index.html": "a", "src/app.js": "b" })
    await ws.publish("first")
    await put(ws.work, { "index.html": "changed" })
    await rm(path.join(ws.work, "src/app.js"))

    await ws.publish("second")

    expect(await ws.log()).toEqual(["second", "first"])
    expect(await ws.files()).toEqual(["index.html"])
  })

  test("commits pushed from elsewhere stay in history", async () => {
    await using tmp = await tmpdir()
    const ws = await workspace(tmp.path)
    await put(ws.work, { "index.html": "a" })
    await ws.publish("first")
    const other = path.join(tmp.path, "other")
    await $`git clone --quiet ${ws.remote} ${other}`.quiet()
    await writeFile(path.join(other, "README.md"), "edited on github")
    await $`git -C ${other} -c user.name=o -c user.email=o@o add README.md`.quiet()
    await $`git -C ${other} -c user.name=o -c user.email=o@o commit --quiet -m theirs`.quiet()
    await $`git -C ${other} push --quiet origin HEAD:main`.quiet()
    await put(ws.work, { "index.html": "b" })

    const result = await ws.publish("mine")

    expect(result.sha).toBeDefined()
    expect(await ws.log()).toEqual(["mine", "theirs", "first"])
  })

  test("files inside nested repositories are pushed with their own ignore rules", async () => {
    await using tmp = await tmpdir()
    const ws = await workspace(tmp.path)
    await put(ws.work, {
      "index.html": "a",
      "my-app/package.json": "{}",
      "my-app/app/page.tsx": "export default 1",
      "my-app/.gitignore": "/.next\n.env*.local\n",
      "my-app/.env.local": "API_KEY=secret",
      "my-app/.next/cache.json": "{}",
      "my-app/node_modules/next/index.js": "1",
      "game/main.js": "b",
    })
    await $`git -C ${path.join(ws.work, "my-app")} init --quiet`.quiet()
    await $`git -C ${path.join(ws.work, "game")} init --quiet`.quiet()
    await $`git -C ${path.join(ws.work, "game")} -c user.name=o -c user.email=o@o commit --quiet --allow-empty -m root`.quiet()

    await ws.publish("first")

    expect(await ws.files()).toEqual([
      "game/main.js",
      "index.html",
      "my-app/.gitignore",
      "my-app/app/page.tsx",
      "my-app/package.json",
    ])
  })

  test("files over 100MB are skipped and reported", async () => {
    await using tmp = await tmpdir()
    const ws = await workspace(tmp.path)
    await put(ws.work, { "index.html": "a", "media/intro.mp4": "" })
    await truncate(path.join(ws.work, "media/intro.mp4"), 101 * 1024 * 1024)

    const result = await ws.publish("first")

    expect(result.skipped).toEqual(["media/intro.mp4"])
    expect(await ws.files()).toEqual(["index.html"])
  })

  test("a workspace with nothing but secrets is refused", async () => {
    await using tmp = await tmpdir()
    const ws = await workspace(tmp.path)
    await put(ws.work, { ".env": "API_KEY=secret" })

    const err = await ws.publish("first").catch((err) => err)

    expect(err).toBeInstanceOf(GitHub.Failure)
    expect(err.code).toBe("empty")
  })
})

describe("GitHub.status", () => {
  test("stays off when the hackathon backend is not configured", async () => {
    await using tmp = await tmpdir()

    expect(await GitHub.status(tmp.path)).toEqual({ enabled: false })
  })

  test("reads the link the team made in Jitda", async () => {
    await using tmp = await tmpdir()
    await using rails = serve({
      enabled: true,
      connected: true,
      connect_url: "https://dev.jitda.io/auth/github?team_id=7",
      login: "octocat",
      linked_by: "홍길동",
      token: "gho_secret_token",
      repo: { owner: "octocat", name: "jitda-app", url: "https://github.com/octocat/jitda-app" },
      push: { sha: "abc1234", at: 1_700_000_000_000, by: "김철수" },
    })

    const status = await GitHub.status(tmp.path)

    expect(status).toEqual({
      enabled: true,
      connectUrl: "https://dev.jitda.io/auth/github?team_id=7",
      login: "octocat",
      linkedBy: "홍길동",
      repo: { owner: "octocat", name: "jitda-app", url: "https://github.com/octocat/jitda-app" },
      push: { sha: "abc1234", time: 1_700_000_000_000, by: "김철수" },
    })
    expect(JSON.stringify(status)).not.toContain("gho_secret_token")
  })

  test("stays off outside the main project directory", async () => {
    await using tmp = await tmpdir()
    await using rails = serve({ enabled: true, connected: true, login: "octocat" })
    process.env["ENK_PROJECT_DIRECTORY"] = path.join(tmp.path, "project-directory")

    expect(await GitHub.status(path.join(tmp.path, "tutorial-directory"))).toEqual({ enabled: false })
    expect((await GitHub.status(path.join(tmp.path, "project-directory"))).enabled).toBe(true)
  })
})

describe("GitHubRoutes", () => {
  const request = (dir: string, method: string, route: string, body?: unknown) =>
    Instance.provide({
      directory: dir,
      fn: () =>
        GitHubRoutes().request(route, {
          method,
          headers: { "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        }),
    })

  test("status hides the feature until the backend is configured", async () => {
    await using tmp = await tmpdir()

    const res = await request(tmp.path, "GET", "/")

    expect(await res.json()).toEqual({ enabled: false })
  })

  test("pushing without a link is refused", async () => {
    await using tmp = await tmpdir()

    const res = await request(tmp.path, "POST", "/push", {})

    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe("unlinked")
  })

  test("pushing without a repository is refused", async () => {
    await using tmp = await tmpdir()
    await using rails = serve({ enabled: true, connected: true, login: "octocat", token: "gho_1" })

    const res = await request(tmp.path, "POST", "/push", {})

    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe("norepo")
  })
})
