import { afterEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import path from "path"
import { mkdir, readFile, rm, writeFile } from "fs/promises"
import { History } from "../../src/enk/history"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(() => {
  delete process.env["ENK_HACKATHON_RAILS_URL"]
  delete process.env["ENK_AI_USAGE_TOKEN"]
  delete process.env["ENK_PROJECT_DIRECTORY"]
})

async function workspace(root: string) {
  const work = path.join(root, "project-directory")
  await mkdir(path.join(work, ".git"), { recursive: true })
  await writeFile(path.join(work, ".git", "opencode"), "team-1-project")
  return work
}

async function put(root: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await writeFile(path.join(root, name), text)
  }
}

const exists = (file: string) => Bun.file(file).exists()

const files = (dir: string, sha: string) =>
  $`git --git-dir=${History.gitdir(dir)} ls-tree -r --name-only ${sha}`
    .quiet()
    .text()
    .then((text) => text.split("\n").filter(Boolean).sort())

const restore = (dir: string, sha: string) =>
  History.restore(dir, { sha, message: (target) => `되돌리기: ${target.subject}`, backup: "되돌리기 전 자동 저장" })

describe("History.commit", () => {
  test("records uploads but leaves out secrets, dependencies and the opencode marker", async () => {
    await using tmp = await tmpdir()
    const work = await workspace(tmp.path)
    await put(work, {
      "index.html": "<h1>hi</h1>",
      "__assets__/photo.png": "png",
      ".env": "API_KEY=secret",
      ".env.example": "API_KEY=",
      "node_modules/pkg/index.js": "module.exports = 1",
    })

    const saved = await History.commit(work, { message: "첫 화면", trailers: { [History.Trailer.message]: "msg_1" } })

    expect(saved?.message).toBe("첫 화면")
    expect(await files(work, saved!.sha)).toEqual([".env.example", "__assets__/photo.png", "index.html"])
  })

  test("skips when nothing changed and lists newest first", async () => {
    await using tmp = await tmpdir()
    const work = await workspace(tmp.path)
    await put(work, { "index.html": "1" })
    await History.commit(work, { message: "하나" })
    expect(await History.commit(work, { message: "그대로" })).toBeUndefined()
    await put(work, { "index.html": "2" })
    const second = await History.commit(work, {
      message: async (changes) => `바뀐 파일 ${changes.length}개`,
    })

    expect(second?.changes).toEqual([{ status: "M", file: "index.html" }])
    expect((await History.list(work)).map((entry) => entry.subject)).toEqual(["바뀐 파일 1개", "하나"])
  })

  test("follows folders that were git-initialized on their own", async () => {
    await using tmp = await tmpdir()
    const work = await workspace(tmp.path)
    await put(work, { "app/package.json": "{}", "app/src/page.js": "1" })
    await $`git init --quiet ${path.join(work, "app")}`.quiet()

    const saved = await History.commit(work, { message: "next 앱" })

    expect(await files(work, saved!.sha)).toEqual(["app/package.json", "app/src/page.js"])
  })

  test("does nothing outside the main event folder", async () => {
    await using tmp = await tmpdir()
    const work = await workspace(tmp.path)
    process.env["ENK_PROJECT_DIRECTORY"] = path.join(tmp.path, "other")
    await put(work, { "index.html": "1" })

    expect(await History.commit(work, { message: "튜토리얼" })).toBeUndefined()
    expect(await History.list(work)).toEqual([])
  })
})

describe("History.restore", () => {
  test("brings back files, removes later ones and stacks a new commit", async () => {
    await using tmp = await tmpdir()
    const work = await workspace(tmp.path)
    await put(work, { "index.html": "v1", "style.css": "a", ".env": "KEY=1" })
    const first = await History.commit(work, { message: "처음" })
    await put(work, { "index.html": "v2", "game/main.js": "x" })
    await rm(path.join(work, "style.css"))
    await History.commit(work, { message: "게임 추가" })

    const restored = await restore(work, first!.sha)

    expect(await readFile(path.join(work, "index.html"), "utf8")).toBe("v1")
    expect(await readFile(path.join(work, "style.css"), "utf8")).toBe("a")
    expect(await exists(path.join(work, "game/main.js"))).toBe(false)
    expect(await exists(path.join(work, "game"))).toBe(false)
    expect(await readFile(path.join(work, ".env"), "utf8")).toBe("KEY=1")
    expect(await exists(path.join(work, ".git", "opencode"))).toBe(true)
    const list = await History.list(work)
    expect(list.map((entry) => entry.subject)).toEqual(["되돌리기: 처음", "게임 추가", "처음"])
    expect(list[0]!.revert).toBe(first!.sha)
    expect(restored.deps).toBe(false)
  })

  test("saves changes made after the last turn before rolling back, so they can be restored", async () => {
    await using tmp = await tmpdir()
    const work = await workspace(tmp.path)
    await put(work, { "index.html": "v1" })
    const first = await History.commit(work, { message: "처음" })
    await put(work, { "__assets__/upload.png": "img" })

    await restore(work, first!.sha)

    const list = await History.list(work)
    expect(list.map((entry) => entry.subject)).toEqual(["되돌리기: 처음", "되돌리기 전 자동 저장", "처음"])
    expect(await exists(path.join(work, "__assets__/upload.png"))).toBe(false)

    await restore(work, list[1]!.sha)
    expect(await readFile(path.join(work, "__assets__/upload.png"), "utf8")).toBe("img")
  })

  test("works inside folders that were git-initialized on their own", async () => {
    await using tmp = await tmpdir()
    const work = await workspace(tmp.path)
    await put(work, { "app/package.json": '{"v":1}' })
    await $`git init --quiet ${path.join(work, "app")}`.quiet()
    const first = await History.commit(work, { message: "처음" })
    await put(work, { "app/package.json": '{"v":2}', "app/src/new.js": "x" })
    await History.commit(work, { message: "의존성" })

    const restored = await restore(work, first!.sha)

    expect(await readFile(path.join(work, "app/package.json"), "utf8")).toBe('{"v":1}')
    expect(await exists(path.join(work, "app/src/new.js"))).toBe(false)
    expect(await exists(path.join(work, "app/.git/HEAD"))).toBe(true)
    expect(restored.deps).toBe(true)
  })

  test("rejects a commit that is not in the history", async () => {
    await using tmp = await tmpdir()
    const work = await workspace(tmp.path)
    await put(work, { "index.html": "v1" })
    await History.commit(work, { message: "처음" })

    expect(restore(work, "0".repeat(40))).rejects.toMatchObject({ code: "missing" })
    expect(restore(work, "HEAD")).rejects.toMatchObject({ code: "missing" })
  })
})

describe("History.open", () => {
  test("is open only while the main event is running", async () => {
    let status = "hackathon_running"
    await using server = Object.assign(Bun.serve({ port: 0, fetch: () => Response.json({ status }) }), {
      [Symbol.asyncDispose]: () => server.stop(true),
    })
    process.env["ENK_HACKATHON_RAILS_URL"] = server.url.origin
    process.env["ENK_AI_USAGE_TOKEN"] = "team-token"

    expect(await History.open()).toBe(true)
    status = "hackathon_ended"
    expect(await History.open()).toBe(false)
  })

  test("is closed when rails cannot be reached", async () => {
    process.env["ENK_HACKATHON_RAILS_URL"] = "http://127.0.0.1:9"
    process.env["ENK_AI_USAGE_TOKEN"] = "team-token"

    expect(await History.open()).toBe(false)
  })
})

describe("History.reminder", () => {
  test("tells the AI about a rollback made after its last reply", async () => {
    await using tmp = await tmpdir()
    const work = await workspace(tmp.path)
    await put(work, { "index.html": "v1" })
    const first = await History.commit(work, { message: "처음" })
    await put(work, { "index.html": "v2" })
    await History.commit(work, { message: "두번째" })
    const before = Date.now()

    expect(await History.reminder(work, before)).toBeUndefined()
    await restore(work, first!.sha)

    expect(await History.reminder(work, before)).toContain('"되돌리기: 처음"')
    expect(await History.reminder(work, before + 2000)).toBeUndefined()
  })
})
