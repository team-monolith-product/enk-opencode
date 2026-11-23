import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test"
import { $ } from "bun"
import path from "path"
import { mkdir, rm, truncate, writeFile } from "fs/promises"
import { GitHub } from "../../src/enk/github"
import { History } from "../../src/enk/history"
import { WorkspaceRepo } from "../../src/enk/workspace-repo"
import { GitHubRoutes } from "../../src/server/routes/github"
import { Instance } from "../../src/project/instance"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
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

const fetchOriginal = globalThis.fetch

/** 팀 pod 가 이야기하는 hackathon-rails 역할. 실제 HTTP 를 그대로 태운다. */
function serve(link: Record<string, unknown>) {
  const reports: unknown[] = []
  const reads = { count: 0 }
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (req.method === "PUT") reports.push(await req.json())
      else reads.count++
      return Response.json(link)
    },
  })
  process.env["ENK_HACKATHON_RAILS_URL"] = server.url.origin
  process.env["ENK_AI_USAGE_TOKEN"] = "team-token"
  return { server, reports, reads, [Symbol.asyncDispose]: () => server.stop(true) }
}

async function workspace(root: string) {
  const work = path.join(root, "project-directory")
  const remote = path.join(root, "remote.git")
  await mkdir(path.join(work, ".git"), { recursive: true })
  await writeFile(path.join(work, ".git", "opencode"), "team-1-project")
  await $`git init --quiet --bare --initial-branch=main ${remote}`.quiet()
  return {
    work,
    remote,
    publish: async (message: string) => {
      await History.commit(work, { message })
      return GitHub.publish({ repo: WorkspaceRepo.open(work), remote, branch: "main", locale: "en", author })
    },
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

async function seed(remote: string, root: string, files: Record<string, string>) {
  const other = path.join(root, "seed")
  await $`git init --quiet --initial-branch=main ${other}`.quiet()
  await put(other, files)
  await $`git -C ${other} add -A -f`.quiet()
  await $`git -C ${other} -c user.name=o -c user.email=o@o commit --quiet -m existing`.quiet()
  await $`git -C ${other} push --quiet ${remote} HEAD:main`.quiet()
}

function fakeGitHub() {
  const original = globalThis.fetch
  const spy = spyOn(globalThis, "fetch").mockImplementation(((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.host !== "api.github.com") return original(input, init)
    return Promise.resolve(
      Response.json({
        name: "jitda-app",
        owner: { login: "octocat" },
        html_url: "https://github.com/octocat/jitda-app",
        private: false,
        default_branch: "main",
        permissions: { push: true },
      }),
    )
  }) as typeof fetch)
  return { [Symbol.dispose]: () => spy.mockRestore() }
}

async function read(file: string) {
  return Bun.file(file)
    .text()
    .catch(() => undefined)
}

async function put(root: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await writeFile(path.join(root, name), text)
  }
}

describe("WorkspaceRepo.ignore", () => {
  test("creates a .gitignore that lists the agent leftovers", async () => {
    await using tmp = await tmpdir()

    await WorkspaceRepo.ignore(tmp.path)

    expect(await Bun.file(path.join(tmp.path, ".gitignore")).text()).toBe(".playwright-mcp/\n")
  })

  test("appends to an existing .gitignore without touching its lines", async () => {
    await using tmp = await tmpdir()
    await writeFile(path.join(tmp.path, ".gitignore"), "dist")

    await WorkspaceRepo.ignore(tmp.path)
    await WorkspaceRepo.ignore(tmp.path)

    expect(await Bun.file(path.join(tmp.path, ".gitignore")).text()).toBe("dist\n.playwright-mcp/\n")
  })

  test("leaves a .gitignore that already covers the folder alone", async () => {
    await using tmp = await tmpdir()
    await writeFile(path.join(tmp.path, ".gitignore"), ".playwright-mcp\n")

    await WorkspaceRepo.ignore(tmp.path)

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
    expect(await ws.files()).toEqual([".env.example", ".gitignore", "index.html", "src/app.js"])
    expect((await $`git --git-dir=${ws.remote} log -1 --format=%an/%ae main`.quiet().text()).trim()).toBe(
      `${author.name}/${author.email}`,
    )
  })

  test("the folder the agent leaves behind stays out once the workspace .gitignore lists it", async () => {
    await using tmp = await tmpdir()
    const ws = await workspace(tmp.path)
    await put(ws.work, { "index.html": "a", ".playwright-mcp/console.log": "log" })
    await WorkspaceRepo.ignore(ws.work)

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

  test("files over 100MB are left out", async () => {
    await using tmp = await tmpdir()
    const ws = await workspace(tmp.path)
    await put(ws.work, { "index.html": "a", "media/intro.mp4": "" })
    await truncate(path.join(ws.work, "media/intro.mp4"), 101 * 1024 * 1024)

    await ws.publish("first")

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

  test("the message is the saved version's title with what changed since the last push", async () => {
    await using tmp = await tmpdir()
    const repo = await workspace(tmp.path)
    await put(repo.work, { "index.html": "<h1>hi</h1>", "old.txt": "bye" })
    await repo.publish("first")
    await put(repo.work, { "index.html": "<h1>hello</h1>", "new.txt": "hi" })
    await rm(path.join(repo.work, "old.txt"))

    await repo.publish("second")
    expect((await repo.publish("again")).sha).toBeUndefined()

    expect(await repo.log()).toEqual(["second", "first"])
    expect((await $`git --git-dir=${repo.remote} log -1 --format=%B main`.quiet().text()).trim()).toBe(
      "second\n\n- Update: index.html\n- Add: new.txt\n- Delete: old.txt",
    )
  })

  test("a rollback goes up as a new commit titled with the rollback", async () => {
    await using tmp = await tmpdir()
    const ws = await workspace(tmp.path)
    await put(ws.work, { "index.html": "v1" })
    await ws.publish("first")
    const first = (await History.list(ws.work)).at(-1)!
    await put(ws.work, { "index.html": "v2" })
    await ws.publish("second")
    await History.restore(ws.work, {
      sha: first.sha,
      message: (target) => `Roll back to: ${target.subject}`,
      backup: "backup",
    })

    await ws.publish("unused")

    expect(await ws.log()).toEqual(["Roll back to: first", "second", "first"])
    expect(await $`git --git-dir=${ws.remote} show main:index.html`.quiet().text()).toBe("v1")
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

async function edit(remote: string, root: string, files: Record<string, string | null>, branch = "main") {
  const other = path.join(root, `other-${Math.random().toString(36).slice(2)}`)
  await $`git clone --quiet --branch ${branch} ${remote} ${other}`.quiet()
  for (const [name, text] of Object.entries(files)) {
    if (text === null) await rm(path.join(other, name))
    else await put(other, { [name]: text })
  }
  await $`git -C ${other} -c user.name=o -c user.email=o@o add -A`.quiet()
  await $`git -C ${other} -c user.name=o -c user.email=o@o commit --quiet -m theirs`.quiet()
  await $`git -C ${other} push --quiet origin HEAD:${branch}`.quiet()
}

async function show(remote: string, spec: string) {
  return $`git --git-dir=${remote} show ${spec}`.quiet().text()
}

async function branches(remote: string) {
  return (await $`git --git-dir=${remote} for-each-ref ${"--format=%(refname:short)"} refs/heads`.quiet().text())
    .split("\n")
    .filter(Boolean)
}

describe("GitHub.publish with changes made on GitHub", () => {
  test("a file changed only on GitHub is kept when Jitda pushes next", async () => {
    await using tmp = await tmpdir()
    const ws = await workspace(tmp.path)
    await put(ws.work, { "index.html": "a", "README.md": "readme" })
    await ws.publish("first")
    await edit(ws.remote, tmp.path, { "README.md": "edited on github", "docs/a.md": "added on github" })
    await put(ws.work, { "index.html": "b" })

    const result = await ws.publish("mine")

    expect(result.conflict).toBeUndefined()
    expect(await ws.log()).toEqual(["mine", "theirs", "first"])
    expect(await ws.files()).toEqual(["README.md", "docs/a.md", "index.html"])
    expect(await show(ws.remote, "main:README.md")).toBe("edited on github")
    expect(await show(ws.remote, "main:index.html")).toBe("b")
  })

  test("a GitHub change survives later pushes that do not touch it", async () => {
    await using tmp = await tmpdir()
    const ws = await workspace(tmp.path)
    await put(ws.work, { "index.html": "a", "README.md": "readme" })
    await ws.publish("first")
    await edit(ws.remote, tmp.path, { "README.md": "edited on github" })
    await put(ws.work, { "index.html": "b" })
    await ws.publish("second")
    await put(ws.work, { "index.html": "c" })

    await ws.publish("third")

    expect(await show(ws.remote, "main:README.md")).toBe("edited on github")
    expect(await show(ws.remote, "main:index.html")).toBe("c")
    expect(await ws.log()).toEqual(["third", "second", "theirs", "first"])
  })

  test("when only GitHub changed, nothing is pushed and the change comes into the workspace", async () => {
    await using tmp = await tmpdir()
    const ws = await workspace(tmp.path)
    await put(ws.work, { "index.html": "a" })
    await ws.publish("first")
    await edit(ws.remote, tmp.path, { "index.html": "edited on github" })

    const result = await ws.publish("again")

    expect(result).toEqual({ absorbed: 1 })
    expect(await show(ws.remote, "main:index.html")).toBe("edited on github")
    expect(await Bun.file(path.join(ws.work, "index.html")).text()).toBe("edited on github")
  })

  test("a push that merges a GitHub-only file also brings it into the workspace", async () => {
    await using tmp = await tmpdir()
    const ws = await workspace(tmp.path)
    await put(ws.work, { "index.html": "a" })
    await ws.publish("first")
    await edit(ws.remote, tmp.path, { "extra.txt": "from github" })
    await put(ws.work, { "index.html": "b" })

    const result = await ws.publish("mine")

    expect(result.sha).toBeDefined()
    expect(result.absorbed).toBe(1)
    expect(await show(ws.remote, "main:index.html")).toBe("b")
    expect(await show(ws.remote, "main:extra.txt")).toBe("from github")
    expect(await Bun.file(path.join(ws.work, "extra.txt")).text()).toBe("from github")
  })

  test("the same place changed on both sides goes to a separate branch and leaves main alone", async () => {
    await using tmp = await tmpdir()
    setSystemTime(new Date("2026-11-21T06:30:15Z"))
    const ws = await workspace(tmp.path)
    await put(ws.work, { "index.html": "line\n", "app.js": "x" })
    await ws.publish("first")
    await edit(ws.remote, tmp.path, { "index.html": "github\n" })
    await put(ws.work, { "index.html": "jitda\n", "app.js": "y" })

    const result = await ws.publish("mine")
    setSystemTime()

    expect(result.sha).toBeUndefined()
    expect(result.conflict).toEqual({
      branch: "jitda/20261121-063015",
      target: "main",
      files: ["index.html"],
      resolving: false,
    })
    expect(await ws.log()).toEqual(["theirs", "first"])
    expect(await show(ws.remote, "main:index.html")).toBe("github\n")
    expect(await show(ws.remote, "jitda/20261121-063015:index.html")).toBe("jitda\n")
    expect(await show(ws.remote, "jitda/20261121-063015:app.js")).toBe("y")
  })

  test("later pushes while the conflict stays go to the same branch", async () => {
    await using tmp = await tmpdir()
    const ws = await workspace(tmp.path)
    await put(ws.work, { "index.html": "line\n" })
    await ws.publish("first")
    await edit(ws.remote, tmp.path, { "index.html": "github\n" })
    await put(ws.work, { "index.html": "jitda\n" })
    const first = await ws.publish("mine")
    await put(ws.work, { "index.html": "jitda again\n" })

    const second = await ws.publish("mine again")

    expect(second.conflict?.branch).toBe(first.conflict!.branch)
    expect(await branches(ws.remote)).toEqual([first.conflict!.branch, "main"].sort())
    expect(await show(ws.remote, `${first.conflict!.branch}:index.html`)).toBe("jitda again\n")
    expect(await show(ws.remote, "main:index.html")).toBe("github\n")
  })

  test("once the branch is merged on GitHub, the next push lands on main again", async () => {
    await using tmp = await tmpdir()
    const ws = await workspace(tmp.path)
    await put(ws.work, { "index.html": "line\n" })
    await ws.publish("first")
    await edit(ws.remote, tmp.path, { "index.html": "github\n" })
    await put(ws.work, { "index.html": "jitda\n" })
    await ws.publish("mine")
    await edit(ws.remote, tmp.path, { "index.html": "jitda\n" })
    await put(ws.work, { "app.js": "new" })

    const result = await ws.publish("after merge")

    expect(result.conflict).toBeUndefined()
    expect(result.sha).toBeDefined()
    expect(await show(ws.remote, "main:index.html")).toBe("jitda\n")
    expect(await show(ws.remote, "main:app.js")).toBe("new")
  })

  test("a team that pushed before this change uses the recorded push as the starting point", async () => {
    await using tmp = await tmpdir()
    const ws = await workspace(tmp.path)
    await put(ws.work, { "index.html": "a", "README.md": "readme" })
    const first = await ws.publish("first")
    const repo = WorkspaceRepo.open(ws.work)
    for (const ref of (await repo.must(["for-each-ref", "--format=%(refname)", "refs/jitda"])).split("\n"))
      if (ref) await repo.must(["update-ref", "-d", ref])
    await edit(ws.remote, tmp.path, { "README.md": "edited on github" })
    await put(ws.work, { "index.html": "b" })
    await History.commit(ws.work, { message: "mine" })

    await GitHub.publish({ repo, remote: ws.remote, branch: "main", locale: "en", author, known: first.sha })

    expect(await show(ws.remote, "main:README.md")).toBe("edited on github")
    expect(await show(ws.remote, "main:index.html")).toBe("b")
  })
})

describe("GitHub.publish when linking a repository that already has files", () => {
  const branches = (remote: string) =>
    $`git --git-dir=${remote} for-each-ref ${"--format=%(refname:short)"} refs/heads`
      .quiet()
      .text()
      .then((text) => text.split("\n").filter(Boolean).sort())

  test("files on both sides that do not overlap are pulled into the workspace and pushed together", async () => {
    await using tmp = await tmpdir()
    const ws = await workspace(tmp.path)
    await seed(ws.remote, tmp.path, { "README.md": "mine on github", "main.py": "print(1)" })
    await put(ws.work, { "index.html": "jitda" })

    const result = await ws.publish("first")

    expect(result.conflict).toBeUndefined()
    expect(result.sha).toBeDefined()
    expect(result.absorbed).toBe(2)
    expect(await read(path.join(ws.work, "README.md"))).toBe("mine on github")
    expect(await ws.files()).toEqual(["README.md", "index.html", "main.py"])
    expect(await ws.log()).toEqual(["first", "existing"])
  })

  test("an overlapping file leaves the default branch alone and puts the workspace on a side branch", async () => {
    await using tmp = await tmpdir()
    const ws = await workspace(tmp.path)
    await seed(ws.remote, tmp.path, { "index.html": "github", "README.md": "readme" })
    await put(ws.work, { "index.html": "jitda" })

    const result = await ws.publish("first")
    await put(ws.work, { "index.html": "jitda 2" })
    const again = await ws.publish("second")

    expect(result.sha).toBeUndefined()
    expect(result.conflict).toMatchObject({ target: "main", linking: true, resolving: false, files: ["index.html"] })
    expect(await ws.log()).toEqual(["existing"])
    expect(await branches(ws.remote)).toEqual([result.conflict!.branch, "main"].sort())
    expect(await show(ws.remote, `${result.conflict!.branch}:index.html`)).toBe("jitda 2")
    expect(again.conflict?.branch).toBe(result.conflict!.branch)
    expect(await read(path.join(ws.work, "README.md"))).toBeUndefined()
  })

  test("a blank workspace takes the repository as it is", async () => {
    await using tmp = await tmpdir()
    const ws = await workspace(tmp.path)
    await seed(ws.remote, tmp.path, { "README.md": "mine on github", "src/main.js": "go()" })
    await WorkspaceRepo.ignore(ws.work)

    const result = await ws.publish("first")

    expect(result.conflict).toBeUndefined()
    expect(result.absorbed).toBeGreaterThan(0)
    expect(await read(path.join(ws.work, "README.md"))).toBe("mine on github")
    expect(await read(path.join(ws.work, "src/main.js"))).toBe("go()")
    expect(await ws.log()).toEqual(["existing"])
  })

  test("a page pulled from GitHub goes back up byte for byte, so the next push sees no change", async () => {
    await using tmp = await tmpdir()
    const ws = await workspace(tmp.path)
    const tag = `<script src="/__preview-bridge.js" data-preview-bridge></script>`
    const page = "<!doctype html>\n<html>\n<head>\n<title>b</title>\n</head>\n<body></body>\n</html>\n"
    await seed(ws.remote, tmp.path, { "about.html": page })
    await put(ws.work, {
      "index.html": `<html><head>${tag}\n<title>a</title></head></html>`,
      "__preview-bridge.js": "b",
    })

    const first = await ws.publish("first")
    const after = await ws.publish("next")

    expect(first.conflict).toBeUndefined()
    expect(await read(path.join(ws.work, "about.html"))).toBe(page)
    expect(await show(ws.remote, "main:about.html")).toBe(page)
    expect(await show(ws.remote, "main:index.html")).toBe("<html><head><title>a</title></head></html>")
    expect(after.sha).toBeUndefined()
  })
})

describe("GitHub.pick", () => {
  const text = "a\n<<<<<<< ours\njitda\n=======\ngithub\n>>>>>>> theirs\nb\n"

  test("keeps Jitda's side", () => {
    expect(GitHub.pick(text, "ours")).toBe("a\njitda\nb\n")
  })

  test("keeps GitHub's side and drops a diff3 base section", () => {
    const diff3 = "<<<<<<< ours\nx\n||||||| base\no\n=======\ny\n>>>>>>> theirs\n"
    expect(GitHub.pick(text, "theirs")).toBe("a\ngithub\nb\n")
    expect(GitHub.pick(diff3, "ours")).toBe("x\n")
    expect(GitHub.pick(diff3, "theirs")).toBe("y\n")
  })
})

describe("GitHub.absorb", () => {
  const link = {
    enabled: true,
    connected: true,
    login: "octocat",
    token: "gho_1",
    repo: { owner: "octocat", name: "jitda-app", url: "https://github.com/octocat/jitda-app" },
  }

  async function conflicted(root: string) {
    const hub = path.join(root, "hub")
    const bare = path.join(hub, "octocat", "jitda-app.git")
    await mkdir(path.dirname(bare), { recursive: true })
    await $`git init --quiet --bare --initial-branch=main ${bare}`.quiet()
    const config = path.join(root, "gitconfig")
    await writeFile(config, `[url "file://${hub}/"]\n\tinsteadOf = https://github.com/\n`)
    process.env["GIT_CONFIG_GLOBAL"] = config
    const work = path.join(root, "work")
    const repo = WorkspaceRepo.open(work)
    const publish = async (message: string) => {
      await History.commit(work, { message })
      return GitHub.publish({
        repo,
        remote: "https://github.com/octocat/jitda-app.git",
        branch: "main",
        locale: "en",
        author,
      })
    }
    await put(work, { "index.html": "<h1>hi</h1>\n", "logo.bin": "\0a", "README.md": "readme" })
    await publish("first")
    await edit(bare, root, { "index.html": "<h1>github</h1>\n", "logo.bin": "\0b", "README.md": "from github" })
    await put(work, { "index.html": "<h1>jitda</h1>\n", "logo.bin": "\0c" })
    const result = await publish("mine")
    return { bare, work, publish, result }
  }

  const absorb = (dir: string) =>
    Instance.provide({ directory: dir, fn: () => GitHub.absorb(dir, { backup: "backup" }) })

  test("for a repository that already had files, brings in GitHub-only files and marks files that differ", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve(link)
    const hub = path.join(tmp.path, "hub")
    const bare = path.join(hub, "octocat", "jitda-app.git")
    await mkdir(path.dirname(bare), { recursive: true })
    await $`git init --quiet --bare --initial-branch=main ${bare}`.quiet()
    const config = path.join(tmp.path, "gitconfig")
    await writeFile(config, `[url "file://${hub}/"]\n\tinsteadOf = https://github.com/\n`)
    process.env["GIT_CONFIG_GLOBAL"] = config
    await seed(bare, tmp.path, { "README.md": "from github", "app.py": "print('github')\n" })
    const work = path.join(tmp.path, "work")
    await put(work, { "app.py": "print('jitda')\n", "jitda.txt": "j" })
    const publish = async (message: string) => {
      await History.commit(work, { message })
      return GitHub.publish({
        repo: WorkspaceRepo.open(work),
        remote: "https://github.com/octocat/jitda-app.git",
        branch: "main",
        locale: "en",
        author,
      })
    }
    const first = await publish("first")
    expect(first.conflict?.linking).toBe(true)

    const result = await absorb(work)
    await put(work, { "app.py": "print('jitda')\nprint('github')\n" })
    const pushed = await publish("merged")

    expect(result.files).toEqual(["app.py"])
    expect(await read(path.join(work, "README.md"))).toBe("from github")
    expect(pushed.sha).toBeDefined()
    expect(await $`git --git-dir=${bare} show main:app.py`.quiet().text()).toBe("print('jitda')\nprint('github')\n")
    expect(
      (await $`git --git-dir=${bare} ls-tree -r --name-only main`.quiet().text()).split("\n").filter(Boolean),
    ).toEqual(["README.md", "app.py", "jitda.txt"])
  })

  test("brings GitHub's changes into the workspace and marks the conflicting lines", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve(link)
    const ws = await conflicted(tmp.path)
    expect(ws.result.conflict?.files).toEqual(["index.html", "logo.bin"])

    const result = await absorb(ws.work)

    expect(result).toEqual({
      files: ["index.html"],
      kept: ["logo.bin"],
      theirs: expect.any(String),
      ours: expect.any(String),
    })
    const html = await Bun.file(path.join(ws.work, "index.html")).text()
    expect(html).toContain("<<<<<<< ")
    expect(html).toContain("<h1>jitda</h1>\n=======\n<h1>github</h1>")
    expect(await Bun.file(path.join(ws.work, "README.md")).text()).toBe("from github")
    expect(await Bun.file(path.join(ws.work, "logo.bin")).text()).toBe("\0c")
  })

  const resolve = (dir: string, prefer: GitHub.Prefer) =>
    Instance.provide({ directory: dir, fn: () => GitHub.resolve(dir, { prefer, locale: "en" }) })

  test("choosing Jitda's side keeps Jitda in the overlap and GitHub elsewhere, then pushes to main", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve(link)
    const ws = await conflicted(tmp.path)
    using _github = fakeGitHub()

    const status = await resolve(ws.work, "ours")

    expect(status.conflict).toBeUndefined()
    expect(
      (await $`git --git-dir=${ws.bare} for-each-ref ${"--format=%(refname:short)"} refs/heads`.quiet().text()).trim(),
    ).toBe("main")
    expect(await show(ws.bare, "main:index.html")).toBe("<h1>jitda</h1>\n")
    expect(await show(ws.bare, "main:README.md")).toBe("from github")
    expect(await show(ws.bare, "main:logo.bin")).toBe("\0c")
  })

  test("choosing GitHub's side takes GitHub in the overlap, binaries included", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve(link)
    const ws = await conflicted(tmp.path)
    using _github = fakeGitHub()

    await resolve(ws.work, "theirs")

    expect(await Bun.file(path.join(ws.work, "index.html")).text()).toBe("<h1>github</h1>\n")
    expect(await Bun.file(path.join(ws.work, "logo.bin")).text()).toBe("\0b")
    expect(await show(ws.bare, "main:index.html")).toBe("<h1>github</h1>\n")
  })

  test("pulling brings GitHub's separate edits into the workspace so the next push keeps them", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve(link)
    const hub = path.join(tmp.path, "hub")
    const bare = path.join(hub, "octocat", "jitda-app.git")
    await mkdir(path.dirname(bare), { recursive: true })
    await $`git init --quiet --bare --initial-branch=main ${bare}`.quiet()
    const config = path.join(tmp.path, "gitconfig")
    await writeFile(config, `[url "file://${hub}/"]\n\tinsteadOf = https://github.com/\n`)
    process.env["GIT_CONFIG_GLOBAL"] = config
    const work = path.join(tmp.path, "work")
    const publish = async (message: string) => {
      await History.commit(work, { message })
      return GitHub.publish({
        repo: WorkspaceRepo.open(work),
        remote: "https://github.com/octocat/jitda-app.git",
        branch: "main",
        locale: "en",
        author,
      })
    }
    const tag = `<script src="/__preview-bridge.js" data-preview-bridge></script>`
    await put(work, { "index.html": `<html>\n<head>${tag}\n<title>a</title>\n</head>\n</html>\n`, "app.js": "1" })
    await publish("first")
    await edit(bare, tmp.path, { "index.html": "<html>\n<head>\n<title>b</title>\n</head>\n</html>\n" })
    await edit(bare, tmp.path, { "app.js": "2" })

    const pulled = await Instance.provide({ directory: work, fn: () => GitHub.pull(work, { locale: "en" }) })
    await put(work, { "new.txt": "n" })
    const pushed = await publish("mine")

    expect(pulled).toEqual(["app.js", "index.html"])
    expect(await Bun.file(path.join(work, "index.html")).text()).toBe(
      `<html>\n<head>${tag}\n\n<title>b</title>\n</head>\n</html>\n`,
    )
    expect(pushed.sha).toBeDefined()
    expect(await show(bare, "main:index.html")).toBe("<html>\n<head>\n<title>b</title>\n</head>\n</html>\n")
    expect(await show(bare, "main:app.js")).toBe("2")
    expect(await show(bare, "main:new.txt")).toBe("n")
  })

  test("pulling records an unsaved edit first, so a file changed on both sides is left alone", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve(link)
    const hub = path.join(tmp.path, "hub")
    const bare = path.join(hub, "octocat", "jitda-app.git")
    await mkdir(path.dirname(bare), { recursive: true })
    await $`git init --quiet --bare --initial-branch=main ${bare}`.quiet()
    const config = path.join(tmp.path, "gitconfig")
    await writeFile(config, `[url "file://${hub}/"]\n\tinsteadOf = https://github.com/\n`)
    process.env["GIT_CONFIG_GLOBAL"] = config
    const work = path.join(tmp.path, "work")
    await put(work, { "app.js": "1\n" })
    await History.commit(work, { message: "first" })
    await GitHub.publish({
      repo: WorkspaceRepo.open(work),
      remote: "https://github.com/octocat/jitda-app.git",
      branch: "main",
      locale: "en",
      author,
    })
    await edit(bare, tmp.path, { "app.js": "github\n" })
    await put(work, { "app.js": "uploaded\n" })

    const pulled = await Instance.provide({ directory: work, fn: () => GitHub.pull(work, { locale: "en" }) })

    expect(pulled).toBeUndefined()
    expect(await Bun.file(path.join(work, "app.js")).text()).toBe("uploaded\n")
  })

  test("pulling when GitHub has nothing new leaves no backup version", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve(link)
    const hub = path.join(tmp.path, "hub")
    const bare = path.join(hub, "octocat", "jitda-app.git")
    await mkdir(path.dirname(bare), { recursive: true })
    await $`git init --quiet --bare --initial-branch=main ${bare}`.quiet()
    const config = path.join(tmp.path, "gitconfig")
    await writeFile(config, `[url "file://${hub}/"]\n\tinsteadOf = https://github.com/\n`)
    process.env["GIT_CONFIG_GLOBAL"] = config
    const work = path.join(tmp.path, "work")
    const repo = WorkspaceRepo.open(work)
    await put(work, { "app.js": "1\n" })
    await History.commit(work, { message: "first" })
    await GitHub.publish({
      repo,
      remote: "https://github.com/octocat/jitda-app.git",
      branch: "main",
      locale: "en",
      author,
    })
    await put(work, { "app.js": "uploaded\n" })
    const count = async () => (await repo.must(["rev-list", "--count", WorkspaceRepo.HEAD])).trim()
    const before = await count()

    const pulled = await Instance.provide({ directory: work, fn: () => GitHub.pull(work, { locale: "en" }) })

    expect(pulled).toBeUndefined()
    expect(await count()).toBe(before)
  })

  test("pulling a GitHub change Jitda already has moves the base so later turns leave no backup", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve(link)
    const hub = path.join(tmp.path, "hub")
    const bare = path.join(hub, "octocat", "jitda-app.git")
    await mkdir(path.dirname(bare), { recursive: true })
    await $`git init --quiet --bare --initial-branch=main ${bare}`.quiet()
    const config = path.join(tmp.path, "gitconfig")
    await writeFile(config, `[url "file://${hub}/"]\n\tinsteadOf = https://github.com/\n`)
    process.env["GIT_CONFIG_GLOBAL"] = config
    const work = path.join(tmp.path, "work")
    const repo = WorkspaceRepo.open(work)
    await put(work, { "app.js": "1\n" })
    await History.commit(work, { message: "first" })
    await GitHub.publish({
      repo,
      remote: "https://github.com/octocat/jitda-app.git",
      branch: "main",
      locale: "en",
      author,
    })
    await edit(bare, tmp.path, { "app.js": "2\n" })
    await put(work, { "app.js": "2\n" })
    await History.commit(work, { message: "same" })
    const pull = () => Instance.provide({ directory: work, fn: () => GitHub.pull(work, { locale: "en" }) })
    await pull()
    await put(work, { "app.js": "uploaded\n" })
    const count = async () => (await repo.must(["rev-list", "--count", WorkspaceRepo.HEAD])).trim()
    const before = await count()

    await pull()

    expect(await count()).toBe(before)
  })

  test("a conflict kept for another repository is dropped once the team links a different one", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve(link)
    const ws = await conflicted(tmp.path)
    expect(ws.result.conflict).toBeDefined()
    const other = path.join(tmp.path, "hub", "octocat", "other.git")
    await $`git init --quiet --bare --initial-branch=main ${other}`.quiet()

    const result = await GitHub.publish({
      repo: WorkspaceRepo.open(ws.work),
      remote: "https://github.com/octocat/other.git",
      branch: "main",
      locale: "en",
      author,
    })

    expect(result.conflict).toBeUndefined()
    expect(result.sha).toBeDefined()
    expect(await GitHub.conflictOf(ws.work)).toBeUndefined()
    expect(
      (
        await $`git --git-dir=${ws.bare} for-each-ref ${"--format=%(refname:short)"} refs/heads/jitda`.quiet().text()
      ).trim(),
    ).toBe(ws.result.conflict!.branch)
  })

  test("the push at the end of a turn keeps the turn's title even after pulling GitHub changes", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve(link)
    using _github = fakeGitHub()
    const hub = path.join(tmp.path, "hub")
    const bare = path.join(hub, "octocat", "jitda-app.git")
    await mkdir(path.dirname(bare), { recursive: true })
    await $`git init --quiet --bare --initial-branch=main ${bare}`.quiet()
    const config = path.join(tmp.path, "gitconfig")
    await writeFile(config, `[url "file://${hub}/"]\n\tinsteadOf = https://github.com/\n`)
    process.env["GIT_CONFIG_GLOBAL"] = config
    const work = path.join(tmp.path, "work")
    await put(work, { "app.js": "1\n" })
    await History.commit(work, { message: "first" })
    await GitHub.publish({
      repo: WorkspaceRepo.open(work),
      remote: "https://github.com/octocat/jitda-app.git",
      branch: "main",
      locale: "en",
      author,
    })
    await edit(bare, tmp.path, { "readme.md": "github" })
    await put(work, { "app.js": "2\n" })
    await History.commit(work, { message: "Change app.js" })

    await Instance.provide({ directory: work, fn: () => GitHub.sync(work, "en") })

    expect((await $`git --git-dir=${bare} log -1 --format=%s main`.quiet().text()).trim()).toBe("Change app.js")
    expect(await show(bare, "main:readme.md")).toBe("github")
    expect(await show(bare, "main:app.js")).toBe("2\n")
  })

  test("pulling leaves an overlapping file alone for the push to report", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve(link)
    const hub = path.join(tmp.path, "hub")
    const bare = path.join(hub, "octocat", "jitda-app.git")
    await mkdir(path.dirname(bare), { recursive: true })
    await $`git init --quiet --bare --initial-branch=main ${bare}`.quiet()
    const config = path.join(tmp.path, "gitconfig")
    await writeFile(config, `[url "file://${hub}/"]\n\tinsteadOf = https://github.com/\n`)
    process.env["GIT_CONFIG_GLOBAL"] = config
    const work = path.join(tmp.path, "work")
    await put(work, { "index.html": "<h1>hi</h1>\n" })
    await History.commit(work, { message: "first" })
    await GitHub.publish({
      repo: WorkspaceRepo.open(work),
      remote: "https://github.com/octocat/jitda-app.git",
      branch: "main",
      locale: "en",
      author,
    })
    await edit(bare, tmp.path, { "index.html": "<h1>github</h1>\n" })
    await put(work, { "index.html": "<h1>jitda</h1>\n" })
    await History.commit(work, { message: "mine" })

    const pulled = await Instance.provide({ directory: work, fn: () => GitHub.pull(work, { locale: "en" }) })

    expect(pulled).toBeUndefined()
    expect(await Bun.file(path.join(work, "index.html")).text()).toBe("<h1>jitda</h1>\n")
  })

  test("a push that slips in before the AI answers never lands on main", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve(link)
    const ws = await conflicted(tmp.path)
    const before = await $`git --git-dir=${ws.bare} rev-parse main`.quiet().text()

    await absorb(ws.work)
    const stray = await GitHub.publish({
      repo: WorkspaceRepo.open(ws.work),
      remote: "https://github.com/octocat/jitda-app.git",
      branch: "main",
      locale: "en",
      author,
    })

    expect(stray.sha).toBeUndefined()
    expect(stray.conflict).toBeDefined()
    expect(await $`git --git-dir=${ws.bare} rev-parse main`.quiet().text()).toBe(before)
  })

  test("once the AI clears the markers, the next push lands on main with both sides", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve(link)
    const ws = await conflicted(tmp.path)
    await absorb(ws.work)
    await put(ws.work, { "index.html": "<h1>jitda and github</h1>\n" })

    const result = await ws.publish("resolved")

    expect(result.conflict).toBeUndefined()
    expect(await show(ws.bare, "main:index.html")).toBe("<h1>jitda and github</h1>\n")
    expect(await show(ws.bare, "main:README.md")).toBe("from github")
    expect(await show(ws.bare, "main:logo.bin")).toBe("\0c")
  })

  test("markers left behind keep main untouched and go to the branch again", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve(link)
    const ws = await conflicted(tmp.path)
    await absorb(ws.work)

    const result = await ws.publish("not resolved")

    expect(result.conflict).toMatchObject({ branch: ws.result.conflict!.branch, files: ["index.html"] })
    expect(await show(ws.bare, "main:index.html")).toBe("<h1>github</h1>\n")
  })

  test("choosing a side after the branch was merged on GitHub pushes and deletes the branch", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve(link)
    const ws = await conflicted(tmp.path)
    using _github = fakeGitHub()
    const settled: string[] = []
    const off = GitHub.onSettle((dir) => settled.push(dir))
    await edit(ws.bare, tmp.path, { "index.html": "<h1>jitda</h1>\n", "logo.bin": "\0c" })

    await resolve(ws.work, "ours")
    off()

    expect(await GitHub.conflictOf(ws.work)).toBeUndefined()
    expect(settled).toEqual([ws.work])
    expect(
      (await $`git --git-dir=${ws.bare} for-each-ref ${"--format=%(refname:short)"} refs/heads`.quiet().text()).trim(),
    ).toBe("main")
  })

  test("is refused when there is no conflict", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve(link)
    const work = path.join(tmp.path, "work")
    await put(work, { "index.html": "a" })

    await expect(absorb(work)).rejects.toMatchObject({ code: "clean" })
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

const create = (dir: string, input: Parameters<typeof GitHub.create>[1]) =>
  Instance.provide({ directory: dir, fn: () => GitHub.create(dir, input) })

const select = (dir: string, input: Parameters<typeof GitHub.select>[1]) =>
  Instance.provide({ directory: dir, fn: () => GitHub.select(dir, input) })

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

    const status = await create(work, { name: "jitda-app" })

    expect(github.calls).toEqual(["POST /user/repos", "GET /repos/octocat/jitda-app"])
    expect(status.firstPush).toBeUndefined()
    expect(await origin.files()).toEqual([".gitignore", "index.html"])
    expect(await origin.subjects()).toEqual(["짓다에서 처음 올린 내용"])
    expect((await History.list(work))[0]?.subject).toBe("짓다에서 처음 올린 내용")
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

    const status = await create(work, { name: "jitda-app" })

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

    const status = await create(work, { name: "jitda-app" })

    expect(status.firstPush).toBeUndefined()
    expect(await origin.files()).toEqual([".gitignore"])
  })

  test("names the first commit in the viewer locale", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve(link)
    const origin = await hub(tmp.path)
    const work = path.join(tmp.path, "work")
    await put(work, { "index.html": "a" })
    using _github = mockGitHub(() => Response.json({ ...remote, default_branch: "main", permissions: { push: true } }))

    await create(work, { name: "jitda-app", locale: "en" })

    expect(await origin.subjects()).toEqual(["First push from Jitda"])
  })

  test("retries the first push three times and keeps the failure reason", async () => {
    await using tmp = await tmpdir()
    await using rails = serve(link)
    using github = mockGitHub(() => Response.json({ message: "Server Error" }, { status: 500 }))

    const status = await create(tmp.path, { name: "jitda-app" })

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

    const status = await create(work, { name: "jitda-app" })

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

    await create(work, { name: "jitda-app" })

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
    const created = await create(work, { name: "jitda-app" })
    expect(created.firstPush).toMatchObject({ attempts: 3, code: "remote" })

    healthy = true
    await put(work, { "index.html": "b" })
    await History.commit(work, { message: "later" })
    await GitHub.push(work, {})

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
      const status = await create(tmp.path, { name: "jitda-app" })

      expect(github.calls.filter((call) => call.startsWith("GET"))).toHaveLength(1)
      expect(status.firstPush).toMatchObject({ attempts: 1, code: "remote" })
    } finally {
      setSystemTime()
    }
  })

  test("while the AI is answering, the first push sends the last saved version instead of half-edited files", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve(link)
    const origin = await hub(tmp.path)
    const work = path.join(tmp.path, "work")
    await put(work, { "index.html": "saved" })
    await History.commit(work, { message: "저장된 턴" })
    await put(work, { "index.html": "half", "draft.js": "x" })
    using _github = mockGitHub(() => Response.json({ ...remote, default_branch: "main", permissions: { push: true } }))

    await Instance.provide({
      directory: work,
      fn: async () => {
        await SessionStatus.set(SessionID.make("ses_busy"), { type: "busy" })
        await GitHub.create(work, { name: "jitda-app" })
      },
    })

    expect(await origin.files()).toEqual(["index.html"])
    expect((await History.list(work)).map((entry) => entry.subject)).toEqual(["저장된 턴"])
  })

  test("a refusal that retrying cannot fix is reported after one attempt", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve(link)
    using github = mockGitHub(() => Response.json({ ...remote, permissions: { push: false } }))

    const status = await create(tmp.path, { name: "jitda-app" })

    expect(github.calls).toEqual(["POST /user/repos", "GET /repos/octocat/jitda-app"])
    expect(status.firstPush).toMatchObject({ attempts: 1, code: "forbidden" })
  })

  test("lists the repositories the GitHub App was installed on", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve({
      repositories: [
        { owner: "octocat", name: "demo", url: "https://github.com/octocat/demo", private: true, pushable: true },
        { owner: "octocat", name: "blog", url: "https://github.com/octocat/blog", private: false, pushable: true },
      ],
    })

    const list = await GitHub.repositories(tmp.path)

    expect(list).toEqual([
      { owner: "octocat", name: "demo", url: "https://github.com/octocat/demo", private: true },
      { owner: "octocat", name: "blog", url: "https://github.com/octocat/blog", private: false },
    ])
  })

  test("listing without a link is refused", async () => {
    await using tmp = await tmpdir()
    const server = Bun.serve({ port: 0, fetch: () => Response.json({}, { status: 409 }) })
    process.env["ENK_HACKATHON_RAILS_URL"] = server.url.origin
    process.env["ENK_AI_USAGE_TOKEN"] = "team-token"

    const failure = await GitHub.repositories(tmp.path).catch((err) => err)
    await server.stop(true)

    expect(failure).toBeInstanceOf(GitHub.Failure)
    expect(failure.code).toBe("unlinked")
  })

  test("choosing a repository binds it and pushes the workspace once", async () => {
    await using tmp = await tmpdir()
    await using rails = serve({
      ...link,
      app: true,
      repo: { owner: "octocat", name: "jitda-app", url: "https://github.com/octocat/jitda-app" },
    })
    const origin = await hub(tmp.path)
    const work = path.join(tmp.path, "work")
    await put(work, { "index.html": "<h1>hi</h1>", ".env": "KEY=secret" })
    using github = mockGitHub(() => Response.json({ ...remote, default_branch: "main", permissions: { push: true } }))

    const status = await select(work, { owner: "octocat", name: "jitda-app" })

    expect(rails.reports[0]).toEqual({ repo_owner: "octocat", repo_name: "jitda-app" })
    expect(github.calls).toEqual(["GET /repos/octocat/jitda-app"])
    expect(status.firstPush).toBeUndefined()
    expect(await origin.files()).toEqual([".gitignore", "index.html"])
    expect(rails.reports[1]).toMatchObject({ pushed_sha: expect.any(String) })
  })

  test("choosing a repository that already has other files leaves it alone and offers to line them up", async () => {
    await using tmp = await tmpdir()
    await using rails = serve({
      ...link,
      app: true,
      repo: { owner: "octocat", name: "jitda-app", url: "https://github.com/octocat/jitda-app" },
    })
    await hub(tmp.path)
    await seed(path.join(tmp.path, "hub", "octocat", "jitda-app.git"), tmp.path, {
      "index.html": "<h1>github</h1>",
      "README.md": "on github",
    })
    const work = path.join(tmp.path, "work")
    await put(work, { "index.html": "<h1>hi</h1>" })
    using _github = mockGitHub(() => Response.json({ ...remote, default_branch: "main", permissions: { push: true } }))

    const status = await select(work, { owner: "octocat", name: "jitda-app" })

    expect(status.firstPush).toBeUndefined()
    expect(status.conflict?.linking).toBe(true)
    expect(rails.reports).toHaveLength(1)

    const resolved = await Instance.provide({
      directory: work,
      fn: () => GitHub.resolve(work, { prefer: "theirs" }),
    })

    expect(resolved.conflict).toBeUndefined()
    expect(await read(path.join(work, "README.md"))).toBe("on github")
    expect(await read(path.join(work, "index.html"))).toBe("<h1>github</h1>")
  })

  test("a GitHub App link pushes even though the installation token reports no push permission", async () => {
    await using tmp = await tmpdir()
    await using rails = serve({
      ...link,
      app: true,
      repo: { owner: "octocat", name: "jitda-app", url: "https://github.com/octocat/jitda-app" },
    })
    const origin = await hub(tmp.path)
    const work = path.join(tmp.path, "work")
    await put(work, { "index.html": "<h1>hi</h1>" })
    using _github = mockGitHub(() => Response.json({ ...remote, default_branch: "main", permissions: { push: false } }))

    const status = await select(work, { owner: "octocat", name: "jitda-app" })

    expect(status.firstPush).toBeUndefined()
    expect(await origin.files()).toEqual([".gitignore", "index.html"])
    expect(rails.reports[1]).toMatchObject({ pushed_sha: expect.any(String) })
  })

  test("a push reports the repository visibility GitHub has now", async () => {
    await using tmp = await tmpdir()
    await using rails = serve({
      ...link,
      app: true,
      repo: { owner: "octocat", name: "jitda-app", url: "https://github.com/octocat/jitda-app", private: false },
    })
    const origin = await hub(tmp.path)
    const work = path.join(tmp.path, "work")
    await put(work, { "index.html": "<h1>hi</h1>" })
    using _github = mockGitHub(() => Response.json({ ...remote, private: true, default_branch: "main" }))

    await select(work, { owner: "octocat", name: "jitda-app" })

    expect(await origin.files()).toEqual([".gitignore", "index.html"])
    expect(rails.reports).toContainEqual({ repo_private: true })
  })

  test("a push without changes still reports a visibility change", async () => {
    await using tmp = await tmpdir()
    await using rails = serve({
      ...link,
      app: true,
      repo: { owner: "octocat", name: "jitda-app", url: "https://github.com/octocat/jitda-app", private: false },
    })
    await hub(tmp.path)
    const work = path.join(tmp.path, "work")
    await put(work, { "index.html": "<h1>hi</h1>" })
    let visible = false
    using _github = mockGitHub(() => Response.json({ ...remote, private: visible, default_branch: "main" }))
    await History.commit(work, { message: "first" })
    await GitHub.push(work, {})
    rails.reports.length = 0
    visible = true

    const result = await GitHub.push(work, {})

    expect(result.sha).toBeUndefined()
    expect(rails.reports).toEqual([{ repo_private: true }])
  })
})

describe("GitHub.sync", () => {
  test("does nothing for a team that has not linked a repository", async () => {
    await using tmp = await tmpdir()
    await using rails = serve({ enabled: true, connected: false })

    await GitHub.sync(tmp.path)

    expect(rails.reads.count).toBe(1)
    expect(rails.reports).toEqual([])
  })

  test("asks the hackathon backend for the link only once per turn", async () => {
    await using tmp = await tmpdir()
    await using rails = serve({
      enabled: true,
      connected: true,
      login: "octocat",
      token: "gho_1",
      repo: { owner: "octocat", name: "jitda-app", url: "https://github.com/octocat/jitda-app" },
    })
    const spy = spyOn(globalThis, "fetch").mockImplementation(((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.host === "api.github.com") return Promise.resolve(Response.json({ message: "down" }, { status: 500 }))
      return fetchOriginal(input, init)
    }) as typeof fetch)

    try {
      await expect(GitHub.sync(tmp.path)).rejects.toMatchObject({ code: "remote" })
      expect(rails.reads.count).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })
})

describe("GitHub.push", () => {
  test("a linked team whose token could not be issued fails as a remote error", async () => {
    await using tmp = await tmpdir()
    await using _rails = serve({ enabled: true, connected: true, login: "octocat", app: true })

    await expect(GitHub.push(tmp.path, { subject: "x" })).rejects.toMatchObject({ code: "remote" })
  })

  test("pushing without a link is refused", async () => {
    await using tmp = await tmpdir()

    await expect(GitHub.push(tmp.path, {})).rejects.toMatchObject({ code: "unlinked" })
  })

  test("pushing without a repository is refused", async () => {
    await using tmp = await tmpdir()
    await using rails = serve({ enabled: true, connected: true, login: "octocat", token: "gho_1" })

    await expect(GitHub.push(tmp.path, {})).rejects.toMatchObject({ code: "norepo" })
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
      const failure = await GitHub.push(tmp.path, { subject: "m" }).catch((err) => err)

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
      const failure = await GitHub.push(tmp.path, { subject: "m" }).catch((err) => err)

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
