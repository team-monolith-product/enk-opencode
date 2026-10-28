import { afterEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import path from "path"
import { mkdir, readFile, rm, truncate, writeFile } from "fs/promises"
import { History } from "../../src/enk/history"
import { HistoryNote } from "../../src/enk/history-note"
import { WorkspaceRepo } from "../../src/enk/workspace-repo"
import type { MessageV2 } from "../../src/session/message-v2"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(() => {
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
  $`git --git-dir=${WorkspaceRepo.open(dir).root} ls-tree -r --name-only ${sha}`
    .quiet()
    .text()
    .then((text) => text.split("\n").filter(Boolean).sort())

const restore = (dir: string, sha: string, after?: string) =>
  History.restore(dir, {
    sha,
    message: (target) => `되돌리기: ${target.subject}`,
    backup: "되돌리기 전 자동 저장",
    after,
  })

describe("History.commit", () => {
  test("records uploads but leaves out secrets, dependencies, the preview bridge and the opencode marker", async () => {
    await using tmp = await tmpdir()
    const work = await workspace(tmp.path)
    await put(work, {
      "index.html": "<h1>hi</h1>",
      "__assets__/photo.png": "png",
      ".env": "API_KEY=secret",
      ".env.example": "API_KEY=",
      "node_modules/pkg/index.js": "module.exports = 1",
      "__preview-bridge.js": "bridge",
      "public/__preview-bridge.js": "bridge",
      ".nfs0000000012345678000001": "deleted while open",
    })

    const saved = await History.commit(work, { message: "첫 화면", turn: "msg_1" })

    expect(saved?.message).toBe("첫 화면")
    expect(await files(work, saved!.sha)).toEqual([".env.example", "__assets__/photo.png", "index.html"])
  })

  test("leaves out files over 100MB and reports them", async () => {
    await using tmp = await tmpdir()
    const work = await workspace(tmp.path)
    await put(work, { "index.html": "a", "media/intro.mp4": "" })
    await truncate(path.join(work, "media/intro.mp4"), 101 * 1024 * 1024)

    const saved = await History.commit(work, { message: "영상" })

    expect(saved?.skipped).toEqual(["media/intro.mp4"])
    expect(await files(work, saved!.sha)).toEqual(["index.html"])
  })

  test("does not save a first version with nothing in it", async () => {
    await using tmp = await tmpdir()
    const work = await workspace(tmp.path)
    await put(work, { ".env": "API_KEY=secret" })

    expect(await History.commit(work, { message: "비밀만" })).toBeUndefined()
    expect(await History.list(work)).toEqual([])
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

  test("saves a turn only once, so the idle after a rollback is not filed under the last turn", async () => {
    await using tmp = await tmpdir()
    const work = await workspace(tmp.path)
    await put(work, { "index.html": "v1" })
    const first = await History.commit(work, { message: "처음", turn: "msg_1" })
    await put(work, { "index.html": "v2" })
    await History.commit(work, { message: "두번째", turn: "msg_2" })
    await restore(work, first!.sha)
    await put(work, { "notes.txt": "after" })

    expect(await History.commit(work, { message: "두번째", turn: "msg_2" })).toBeUndefined()
    expect((await History.list(work))[0]!.subject).toBe("되돌리기: 처음")
    expect(await History.commit(work, { message: "세번째", turn: "msg_3" })).toMatchObject({ message: "세번째" })
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
    await put(work, { "index.html": "v2", "game/main.js": "x", "__preview-bridge.js": "bridge" })
    await rm(path.join(work, "style.css"))
    await History.commit(work, { message: "게임 추가" })

    await restore(work, first!.sha)

    expect(await readFile(path.join(work, "index.html"), "utf8")).toBe("v1")
    expect(await readFile(path.join(work, "style.css"), "utf8")).toBe("a")
    expect(await exists(path.join(work, "game/main.js"))).toBe(false)
    expect(await exists(path.join(work, "game"))).toBe(false)
    expect(await readFile(path.join(work, ".env"), "utf8")).toBe("KEY=1")
    expect(await readFile(path.join(work, "__preview-bridge.js"), "utf8")).toBe("bridge")
    expect(await exists(path.join(work, ".git", "opencode"))).toBe(true)
    const list = await History.list(work)
    expect(list.map((entry) => entry.subject)).toEqual(["되돌리기: 처음", "게임 추가", "처음"])
    expect(list[0]!.revert).toBe(first!.sha)
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

  test("leaves a file that grew past 100MB alone instead of overwriting it with the old copy", async () => {
    await using tmp = await tmpdir()
    const work = await workspace(tmp.path)
    await put(work, { "index.html": "v1", "media/intro.mp4": "small" })
    const first = await History.commit(work, { message: "처음" })
    await put(work, { "index.html": "v2" })
    await truncate(path.join(work, "media/intro.mp4"), 101 * 1024 * 1024)
    await History.commit(work, { message: "큰 영상" })

    const restored = await restore(work, first!.sha)

    expect(restored.changes).toEqual([{ status: "M", file: "index.html" }])
    expect(await readFile(path.join(work, "index.html"), "utf8")).toBe("v1")
    expect(Bun.file(path.join(work, "media/intro.mp4")).size).toBe(101 * 1024 * 1024)
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

    expect(restored.changes).toEqual([
      { status: "M", file: "app/package.json" },
      { status: "D", file: "app/src/new.js" },
    ])
    expect(await readFile(path.join(work, "app/package.json"), "utf8")).toBe('{"v":1}')
    expect(await exists(path.join(work, "app/src/new.js"))).toBe(false)
    expect(await exists(path.join(work, "app/.git/HEAD"))).toBe(true)
  })

  test("jumps straight back to a version many turns ago in one commit", async () => {
    await using tmp = await tmpdir()
    const work = await workspace(tmp.path)
    await put(work, { "index.html": "v0" })
    const first = await History.commit(work, { message: "처음" })
    for (let i = 1; i <= 30; i++) {
      await put(work, { "index.html": `v${i}`, [`page${i}.html`]: String(i) })
      await History.commit(work, { message: `턴 ${i}` })
    }

    const restored = await restore(work, first!.sha)

    expect(await readFile(path.join(work, "index.html"), "utf8")).toBe("v0")
    expect(await exists(path.join(work, "page30.html"))).toBe(false)
    expect(restored.changes).toHaveLength(31)
    const list = await History.list(work)
    expect(list).toHaveLength(32)
    expect(list[0]).toMatchObject({ subject: "되돌리기: 처음", revert: first!.sha })
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

const message = (id: string, role: "user" | "assistant") =>
  ({ info: { id, role }, parts: [] }) as unknown as MessageV2.WithParts

describe("HistoryNote.text", () => {
  test("tells the AI about a rollback only on the first reply after it", async () => {
    await using tmp = await tmpdir()
    const work = await workspace(tmp.path)
    await put(work, { "index.html": "v1" })
    const first = await History.commit(work, { message: "처음" })
    await put(work, { "index.html": "v2" })
    await History.commit(work, { message: "두번째" })
    const before = [message("msg_1", "user"), message("msg_2", "assistant")]

    expect(await HistoryNote.text(work, before, "msg_3")).toBeUndefined()
    await restore(work, first!.sha, "msg_2")

    expect(await HistoryNote.text(work, before, "msg_3")).toContain('"되돌리기: 처음"')
    const after = [...before, message("msg_3", "user"), message("msg_4", "assistant")]
    expect(await HistoryNote.text(work, after, "msg_5")).toBeUndefined()

    const skewed = [...after, message("msg_3a", "user")]
    expect(await HistoryNote.text(work, skewed, "msg_3a")).toBeUndefined()
  })
})
