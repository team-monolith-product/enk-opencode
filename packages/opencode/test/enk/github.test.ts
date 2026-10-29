import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test"
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
  delete process.env["GIT_CONFIG_GLOBAL"]
})

/** 팀 pod 가 이야기하는 hackathon-rails 역할. 실제 HTTP 를 그대로 태운다. */
function serve(link: Record<string, unknown>) {
  const reports: unknown[] = []
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (req.method === "PUT") reports.push(await req.json())
      return Response.json(link)
    },
  })
  process.env["ENK_HACKATHON_RAILS_URL"] = server.url.origin
  process.env["ENK_AI_USAGE_TOKEN"] = "team-token"
  return { server, reports, [Symbol.asyncDispose]: () => server.stop(true) }
}

async function workspace(root: string) {
  const work = path.join(root, "project-directory")
  const remote = path.join(root, "remote.git")
  const gitdir = path.join(root, "gitdir")
  await mkdir(path.join(work, ".git"), { recursive: true })
  await writeFile(path.join(work, ".git", "opencode"), "team-1-project")
  await $`git init --quiet --bare --initial-branch=main ${remote}`.quiet()
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

describe("GitHub.ignore", () => {
  test("creates a .gitignore that lists the agent leftovers", async () => {
    await using tmp = await tmpdir()

    await GitHub.ignore(tmp.path)

    expect(await Bun.file(path.join(tmp.path, ".gitignore")).text()).toBe(".playwright-mcp/\n")
  })

  test("appends to an existing .gitignore without touching its lines", async () => {
    await using tmp = await tmpdir()
    await writeFile(path.join(tmp.path, ".gitignore"), "dist")

    await GitHub.ignore(tmp.path)
    await GitHub.ignore(tmp.path)

    expect(await Bun.file(path.join(tmp.path, ".gitignore")).text()).toBe("dist\n.playwright-mcp/\n")
  })

  test("leaves a .gitignore that already covers the folder alone", async () => {
    await using tmp = await tmpdir()
    await writeFile(path.join(tmp.path, ".gitignore"), ".playwright-mcp\n")

    await GitHub.ignore(tmp.path)

    expect(await Bun.file(path.join(tmp.path, ".gitignore")).text()).toBe(".playwright-mcp\n")
  })
})

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

  test("the folder the agent leaves behind stays out once the workspace .gitignore lists it", async () => {
    await using tmp = await tmpdir()
    const ws = await workspace(tmp.path)
    await put(ws.work, { "index.html": "a", ".playwright-mcp/console.log": "log" })
    await GitHub.ignore(ws.work)

    await ws.publish("first")

    expect(await ws.files()).toEqual([".gitignore", "index.html"])
  })

  test("the agent leftovers stay out even when the workspace .gitignore tries to bring them back", async () => {
    await using tmp = await tmpdir()
    const ws = await workspace(tmp.path)
    await put(ws.work, { "index.html": "a", ".gitignore": "!.playwright-mcp/\n", ".playwright-mcp/page.yml": "page" })

    await ws.publish("first")

    expect(await ws.files()).toEqual([".gitignore", "index.html"])
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
    await $`git clone --quiet --branch main ${ws.remote} ${other}`.quiet()
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

  test("the platform preview bridge stays out of the repository", async () => {
    await using tmp = await tmpdir()
    const ws = await workspace(tmp.path)
    const page = '<body>\n  <h1>hi</h1>\n  <script src="/__preview-bridge.js" data-preview-bridge></script>\n</body>\n'
    const nested =
      '<p>a</p>\n<scr<script src="/__preview-bridge.js" data-preview-bridge></script>ipt data-preview-bridge></script>\n'
    await put(ws.work, {
      "index.html": page,
      "about.html": "<p>no bridge</p>\n",
      "nested.html": nested,
      "__preview-bridge.js": "bridge",
      "public/__preview-bridge.js": "bridge",
    })

    await ws.publish("first")

    expect(await ws.files()).toEqual(["about.html", "index.html", "nested.html"])
    expect(await $`git --git-dir=${ws.remote} show main:nested.html`.quiet().text()).toBe("<p>a</p>\n")
    expect(await $`git --git-dir=${ws.remote} show main:index.html`.quiet().text()).toBe(
      "<body>\n  <h1>hi</h1>\n</body>\n",
    )
    expect(await Bun.file(path.join(ws.work, "index.html")).text()).toBe(page)
    expect((await ws.publish("again")).sha).toBeUndefined()
  })

  test("a generated message sees what changed since the last push", async () => {
    await using tmp = await tmpdir()
    const repo = await workspace(tmp.path)
    await put(repo.work, { "index.html": "<h1>hi</h1>", "old.txt": "bye" })
    await repo.publish("first")
    await put(repo.work, { "index.html": "<h1>hello</h1>", "new.txt": "hi" })
    await rm(path.join(repo.work, "old.txt"))
    const seen: GitHub.Change[][] = []
    const publish = () =>
      GitHub.publish({
        gitdir: path.join(tmp.path, "gitdir"),
        worktree: repo.work,
        remote: repo.remote,
        branch: "main",
        author,
        message: async (changes) => {
          seen.push(changes)
          return "second"
        },
      })

    await publish()
    await publish()

    expect(seen).toEqual([
      [
        { status: "M", file: "index.html" },
        { status: "A", file: "new.txt" },
        { status: "D", file: "old.txt" },
      ],
    ])
    expect(await repo.log()).toEqual(["second", "first"])
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

  test("tells the dialog the team linked through the GitHub App", async () => {
    await using tmp = await tmpdir()
    await using rails = serve({ enabled: true, connected: true, app: true, login: "octocat", token: "ghs_1" })

    expect(await GitHub.status(tmp.path)).toMatchObject({ enabled: true, app: true, login: "octocat" })
  })

  test("stays off outside the main project directory", async () => {
    await using tmp = await tmpdir()
    await using rails = serve({ enabled: true, connected: true, login: "octocat" })
    process.env["ENK_PROJECT_DIRECTORY"] = path.join(tmp.path, "project-directory")

    expect(await GitHub.status(path.join(tmp.path, "tutorial-directory"))).toEqual({ enabled: false })
    expect((await GitHub.status(path.join(tmp.path, "project-directory"))).enabled).toBe(true)
  })

  test("asks the team to connect again once the token is gone", async () => {
    await using tmp = await tmpdir()
    await using rails = serve({
      enabled: true,
      connected: false,
      connect_url: "https://dev.jitda.io/auth/github?team_id=7",
      login: "octocat",
      linked_by: "홍길동",
      repo: { owner: "octocat", name: "jitda-app", url: "https://github.com/octocat/jitda-app" },
    })

    const status = await GitHub.status(tmp.path)

    expect(status.login).toBeUndefined()
    expect(status.linkedBy).toBeUndefined()
    expect(status.connectUrl).toBe("https://dev.jitda.io/auth/github?team_id=7")
    expect(status.repo?.name).toBe("jitda-app")
  })

  test("a token GitHub rejects is dropped so the team can connect again", async () => {
    await using tmp = await tmpdir()
    await using rails = serve({ enabled: true, connected: true, login: "octocat", token: "gho_1" })
    const original = globalThis.fetch
    const github = spyOn(globalThis, "fetch").mockImplementation(((input, init) =>
      new URL(input instanceof Request ? input.url : String(input)).host === "api.github.com"
        ? Promise.resolve(Response.json({ message: "Bad credentials" }, { status: 401 }))
        : original(input, init)) as typeof fetch)

    try {
      await expect(GitHub.create(tmp.path, { name: "jitda-app" })).rejects.toMatchObject({ code: "revoked" })
      expect(rails.reports).toEqual([{ revoked: true }])
    } finally {
      github.mockRestore()
    }
  })
})

describe("GitHub.create", () => {
  const link = {
    enabled: true,
    connected: true,
    login: "octocat",
    token: "gho_1",
    repo: { owner: "octocat", name: "jitda-app", url: "https://github.com/octocat/jitda-app" },
  }
  const remote = {
    name: "jitda-app",
    owner: { login: "octocat" },
    html_url: "https://github.com/octocat/jitda-app",
    private: false,
  }

  async function hub(root: string) {
    const bare = path.join(root, "hub", "octocat", "jitda-app.git")
    await mkdir(path.dirname(bare), { recursive: true })
    await $`git init --quiet --bare --initial-branch=main ${bare}`.quiet()
    const config = path.join(root, "gitconfig")
    await writeFile(config, `[url "file://${path.join(root, "hub")}/"]\n\tinsteadOf = https://github.com/\n`)
    process.env["GIT_CONFIG_GLOBAL"] = config
    return {
      files: () =>
        $`git --git-dir=${bare} ls-tree -r --name-only main`
          .quiet()
          .text()
          .then((text) => text.split("\n").filter(Boolean)),
      subjects: () =>
        $`git --git-dir=${bare} log --format=%s main`
          .quiet()
          .text()
          .then((text) => text.split("\n").filter(Boolean)),
    }
  }

  function mockGitHub(read: () => Response) {
    const original = globalThis.fetch
    const calls: string[] = []
    const spy = spyOn(globalThis, "fetch").mockImplementation(((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.host !== "api.github.com") return original(input, init)
      calls.push(`${init?.method} ${url.pathname}`)
      return Promise.resolve(init?.method === "POST" ? Response.json(remote, { status: 201 }) : read())
    }) as typeof fetch)
    return { calls, [Symbol.dispose]: () => spy.mockRestore() }
  }

  test("pushes the workspace to the new repository and clears the failure", async () => {
    await using tmp = await tmpdir()
    await using rails = serve(link)
    const origin = await hub(tmp.path)
    const work = path.join(tmp.path, "work")
    await put(work, { "index.html": "<h1>hi</h1>", ".env": "KEY=secret" })
    using github = mockGitHub(() => Response.json({ ...remote, default_branch: "main", permissions: { push: true } }))

    const status = await GitHub.create(work, { name: "jitda-app" })

    expect(github.calls).toEqual(["POST /user/repos", "GET /repos/octocat/jitda-app"])
    expect(status.firstPush).toBeUndefined()
    expect(await origin.files()).toEqual([".gitignore", "index.html"])
    expect(await origin.subjects()).toEqual(["Initial commit from Jitda"])
    expect(rails.reports).toHaveLength(2)
    expect(rails.reports[1]).toMatchObject({ pushed_sha: expect.any(String) })
  })

  test("a GitHub App link cannot create a repository", async () => {
    await using tmp = await tmpdir()
    await using rails = serve({ ...link, app: true, repo: undefined })
    const work = path.join(tmp.path, "work")
    await put(work, { "index.html": "<h1>hi</h1>" })
    using github = mockGitHub(() => Response.json(remote))

    const failure = await GitHub.create(work, { name: "jitda-app" }).catch((err) => err)

    expect(failure).toBeInstanceOf(GitHub.Failure)
    expect(failure.code).toBe("app")
    expect(github.calls).toEqual([])
    expect(rails.reports).toEqual([])
  })

  test("a transient failure is retried and the second attempt succeeds", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve(link)
    const origin = await hub(tmp.path)
    const work = path.join(tmp.path, "work")
    await put(work, { "index.html": "a" })
    let reads = 0
    using github = mockGitHub(() =>
      ++reads === 1
        ? Response.json({ message: "Bad Gateway" }, { status: 502 })
        : Response.json({ ...remote, default_branch: "main", permissions: { push: true } }),
    )

    const status = await GitHub.create(work, { name: "jitda-app" })

    expect(github.calls.filter((call) => call.startsWith("GET"))).toHaveLength(2)
    expect(status.firstPush).toBeUndefined()
    expect(await origin.files()).toEqual([".gitignore", "index.html"])
  })

  test("an empty workspace still gets its .gitignore pushed", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve(link)
    const origin = await hub(tmp.path)
    const work = path.join(tmp.path, "work")
    await mkdir(work, { recursive: true })
    using _github = mockGitHub(() => Response.json({ ...remote, default_branch: "main", permissions: { push: true } }))

    const status = await GitHub.create(work, { name: "jitda-app" })

    expect(status.firstPush).toBeUndefined()
    expect(await origin.files()).toEqual([".gitignore"])
  })

  test("a message builder names the first commit", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve(link)
    const origin = await hub(tmp.path)
    const work = path.join(tmp.path, "work")
    await put(work, { "index.html": "a" })
    using _github = mockGitHub(() => Response.json({ ...remote, default_branch: "main", permissions: { push: true } }))

    await GitHub.create(work, { name: "jitda-app", message: async (changes) => `first: ${changes.length}` })

    expect(await origin.subjects()).toEqual(["first: 2"])
  })

  test("retries the first push three times and keeps the failure reason", async () => {
    await using tmp = await tmpdir()
    await using rails = serve(link)
    using github = mockGitHub(() => Response.json({ message: "Server Error" }, { status: 500 }))

    const status = await GitHub.create(tmp.path, { name: "jitda-app" })

    expect(status.repo?.name).toBe("jitda-app")
    expect(github.calls).toEqual([
      "POST /user/repos",
      "GET /repos/octocat/jitda-app",
      "GET /repos/octocat/jitda-app",
      "GET /repos/octocat/jitda-app",
    ])
    expect(status.firstPush).toEqual({ attempts: 3, code: "remote", reason: "Server Error" })
    expect((await GitHub.status(tmp.path)).firstPush).toEqual(status.firstPush)
    expect(rails.reports).toEqual([
      {
        repo_owner: "octocat",
        repo_name: "jitda-app",
        repo_url: "https://github.com/octocat/jitda-app",
        repo_private: false,
      },
    ])
  })

  test("a repository that GitHub has not made visible yet is retried", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve(link)
    const origin = await hub(tmp.path)
    const work = path.join(tmp.path, "work")
    await put(work, { "index.html": "a" })
    let reads = 0
    using github = mockGitHub(() =>
      ++reads === 1
        ? Response.json({ message: "Not Found" }, { status: 404 })
        : Response.json({ ...remote, default_branch: "main", permissions: { push: true } }),
    )

    const status = await GitHub.create(work, { name: "jitda-app" })

    expect(github.calls.filter((call) => call.startsWith("GET"))).toHaveLength(2)
    expect(status.firstPush).toBeUndefined()
    expect(await origin.files()).toEqual([".gitignore", "index.html"])
  })

  test("the first push lists the agent leftovers in the workspace .gitignore and keeps them out", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve(link)
    const origin = await hub(tmp.path)
    const work = path.join(tmp.path, "work")
    await put(work, { "index.html": "a", ".playwright-mcp/console.log": "log" })
    using _github = mockGitHub(() => Response.json({ ...remote, default_branch: "main", permissions: { push: true } }))

    await GitHub.create(work, { name: "jitda-app" })

    expect(await origin.files()).toEqual([".gitignore", "index.html"])
    expect(await Bun.file(path.join(work, ".gitignore")).text()).toBe(".playwright-mcp/\n")
  })

  test("a later successful push clears the recorded first push failure", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve(link)
    const origin = await hub(tmp.path)
    const work = path.join(tmp.path, "work")
    await put(work, { "index.html": "a" })
    let healthy = false
    using _github = mockGitHub(() =>
      healthy
        ? Response.json({ ...remote, default_branch: "main", permissions: { push: true } })
        : Response.json({ message: "Server Error" }, { status: 500 }),
    )
    const created = await GitHub.create(work, { name: "jitda-app" })
    expect(created.firstPush).toMatchObject({ attempts: 3, code: "remote" })

    healthy = true
    await GitHub.push(work, { message: "later" })

    expect((await GitHub.status(work)).firstPush).toBeUndefined()
    expect(await origin.subjects()).toEqual(["later"])
  })

  test("stops retrying once the first push has used up its time budget", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve(link)
    const now = Date.now()
    using github = mockGitHub(() => {
      setSystemTime(now + 61_000)
      return Response.json({ message: "Bad Gateway" }, { status: 502 })
    })

    try {
      const status = await GitHub.create(tmp.path, { name: "jitda-app" })

      expect(github.calls.filter((call) => call.startsWith("GET"))).toHaveLength(1)
      expect(status.firstPush).toMatchObject({ attempts: 1, code: "remote" })
    } finally {
      setSystemTime()
    }
  })

  test("a refusal that retrying cannot fix is reported after one attempt", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve(link)
    using github = mockGitHub(() => Response.json({ ...remote, permissions: { push: false } }))

    const status = await GitHub.create(tmp.path, { name: "jitda-app" })

    expect(github.calls).toEqual(["POST /user/repos", "GET /repos/octocat/jitda-app"])
    expect(status.firstPush).toMatchObject({ attempts: 1, code: "forbidden" })
  })
})

describe("GitHub.push", () => {
  test("pushing without a link is refused", async () => {
    await using tmp = await tmpdir()

    await expect(GitHub.push(tmp.path, { message: "x" })).rejects.toMatchObject({ code: "unlinked" })
  })

  test("pushing without a repository is refused", async () => {
    await using tmp = await tmpdir()
    await using rails = serve({ enabled: true, connected: true, login: "octocat", token: "gho_1" })

    await expect(GitHub.push(tmp.path, { message: "x" })).rejects.toMatchObject({ code: "norepo" })
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
})

describe("GitHub failure reporting", () => {
  test("a rejected GitHub call keeps the raw response without secret headers", async () => {
    await using tmp = await tmpdir()
    await using rails = serve({
      enabled: true,
      connected: true,
      login: "octocat",
      token: "gho_1",
      repo: { owner: "octocat", name: "jitda-app", url: "https://github.com/octocat/jitda-app" },
    })
    const original = globalThis.fetch
    const github = spyOn(globalThis, "fetch").mockImplementation(((input, init) =>
      new URL(input instanceof Request ? input.url : String(input)).host === "api.github.com"
        ? Promise.resolve(
            new Response(`<html>\nnot found\n${"x".repeat(5000)}</html>`, {
              status: 404,
              headers: { "x-github-request-id": "abc", "set-cookie": "s=1" },
            }),
          )
        : original(input, init)) as typeof fetch)

    try {
      const failure = await GitHub.push(tmp.path, { message: "m" }).catch((err) => err)

      expect(failure).toBeInstanceOf(GitHub.Failure)
      expect(failure.code).toBe("missing")
      expect(failure.response.status).toBe(404)
      expect(failure.response.headers["x-github-request-id"]).toBe("abc")
      expect(failure.response.headers["set-cookie"]).toBeUndefined()
      expect(failure.response.body.startsWith("<html>\nnot found")).toBe(true)
      expect(failure.response.body.length).toBeLessThan(4100)
    } finally {
      github.mockRestore()
    }
  })

  test("a long JSON error keeps the GitHub message and trims only the logged body", async () => {
    await using tmp = await tmpdir()
    await using rails = serve({
      enabled: true,
      connected: true,
      login: "octocat",
      token: "gho_1",
      repo: { owner: "octocat", name: "jitda-app", url: "https://github.com/octocat/jitda-app" },
    })
    const original = globalThis.fetch
    const github = spyOn(globalThis, "fetch").mockImplementation(((input, init) =>
      new URL(input instanceof Request ? input.url : String(input)).host === "api.github.com"
        ? Promise.resolve(
            Response.json(
              { message: "Not Found", pad: "x".repeat(6000) },
              { status: 404, headers: { authorization: "Bearer leaked" } },
            ),
          )
        : original(input, init)) as typeof fetch)

    try {
      const failure = await GitHub.push(tmp.path, { message: "m" }).catch((err) => err)

      expect(failure.message).toBe("Not Found")
      expect(failure.response.body.length).toBeLessThan(4100)
      expect(failure.response.headers["authorization"]).toBeUndefined()
      expect(failure.response.request).toBe("GET /repos/octocat/jitda-app")
    } finally {
      github.mockRestore()
    }
  })

  test("identity separates failures by site and ignores volatile parts", () => {
    const at = (request: string) =>
      new GitHub.Failure("missing", 404, "Not Found", {
        status: 404,
        statusText: "Not Found",
        headers: {},
        body: "",
        request,
      })

    expect(GitHub.identity("x", at("GET /repos/a/b"))).not.toBe(GitHub.identity("x", at("POST /user/repos")))
    expect(GitHub.identity("x", new Error("ENOENT /tmp/abc123/file 42"))).toBe(
      GitHub.identity("x", new Error("ENOENT /tmp/zzz999/file 7")),
    )
    expect(GitHub.identity("x", new TypeError("a"))).not.toBe(GitHub.identity("x", new Error("a")))
  })

  test("scope groups one failure kind across repositories and keeps kinds apart", () => {
    const failure = (code: GitHub.Code, status: 404 | 409 | 422 | 502, request: string) =>
      new GitHub.Failure(code, status, "x", { status, statusText: "", headers: {}, body: "", request })

    const first = GitHub.scope("request failed", failure("missing", 404, "GET /repos/alice/one"))
    const other = GitHub.scope("request failed", failure("missing", 404, "GET /repos/bob/two"))
    const revoked = GitHub.scope("request failed", failure("revoked", 409, "GET /repos/alice/one"))

    expect(first?.fingerprint).toEqual(other?.fingerprint)
    expect(first?.fingerprint).not.toEqual(revoked?.fingerprint)
    expect(first?.tags).toEqual({ "github.code": "missing", "github.status": "404" })
    expect(GitHub.scope("request failed", new Error("boom"))).toBeUndefined()
  })

  test("dump keeps the code and the raw response", () => {
    const response = { status: 404, statusText: "Not Found", headers: { "x-github-request-id": "1" }, body: "{}" }
    const dumped = GitHub.dump(new GitHub.Failure("missing", 404, "Not Found", response))

    expect(dumped).toMatchObject({ code: "missing", message: "Not Found", response })
  })
})
