import { test, expect, describe } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { History } from "../../src/enk/history"
import { FileRemove } from "../../src/file/remove"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

async function seed(dir: string) {
  await fs.mkdir(path.join(dir, "src/deep"), { recursive: true })
  await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
  await fs.writeFile(path.join(dir, ".nfs0000000012345678"), "held")
  await fs.writeFile(path.join(dir, "a.txt"), "a")
  await fs.writeFile(path.join(dir, "src/deep/b.txt"), "b")
  await fs.writeFile(path.join(dir, ".opencode/keep.json"), "{}")
}

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  )

describe("FileRemove.resolve", () => {
  test("accepts files and folders inside the project", async () => {
    await using tmp = await tmpdir({ git: true })
    await seed(tmp.path)
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await FileRemove.resolve("a.txt")).toBe(path.join(tmp.path, "a.txt"))
        expect(await FileRemove.resolve("src/deep")).toBe(path.join(tmp.path, "src/deep"))
        expect(await FileRemove.resolve("/src//deep/")).toBe(path.join(tmp.path, "src/deep"))
      },
    })
  })

  test("rejects the root, traversal and protected folders", async () => {
    await using tmp = await tmpdir({ git: true })
    await seed(tmp.path)
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await FileRemove.resolve("")).toBeUndefined()
        expect(await FileRemove.resolve(".")).toBeUndefined()
        expect(await FileRemove.resolve("../outside")).toBeUndefined()
        expect(await FileRemove.resolve("src/../../outside")).toBeUndefined()
        expect(await FileRemove.resolve(".git")).toBeUndefined()
        expect(await FileRemove.resolve(".git/config")).toBeUndefined()
      },
    })
  })

  test("rejects a path that escapes through a symlinked folder", async () => {
    await using tmp = await tmpdir({ git: true })
    await using outside = await tmpdir()
    await fs.writeFile(path.join(outside.path, "secret.txt"), "x")
    await fs.symlink(outside.path, path.join(tmp.path, "link"))
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await FileRemove.resolve("link/secret.txt")).toBeUndefined()
      },
    })
    expect(await exists(path.join(outside.path, "secret.txt"))).toBe(true)
  })
})

describe("FileRemove.remove / clear", () => {
  test("removes a folder recursively and leaves siblings alone", async () => {
    await using tmp = await tmpdir({ git: true })
    await seed(tmp.path)
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await FileRemove.remove((await FileRemove.resolve("src"))!)
      },
    })
    expect(await exists(path.join(tmp.path, "src"))).toBe(false)
    expect(await exists(path.join(tmp.path, "a.txt"))).toBe(true)
  })

  test("clear empties the folder, dot files and .opencode included, and keeps only .git", async () => {
    await using tmp = await tmpdir({ git: true })
    await seed(tmp.path)
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await FileRemove.clear()
      },
    })
    expect(await exists(path.join(tmp.path, "a.txt"))).toBe(false)
    expect(await exists(path.join(tmp.path, "src"))).toBe(false)
    expect(await exists(path.join(tmp.path, ".git"))).toBe(true)
    expect(await exists(path.join(tmp.path, ".opencode"))).toBe(false)
    expect(await exists(path.join(tmp.path, ".nfs0000000012345678"))).toBe(false)
    expect(await fs.readdir(tmp.path)).toEqual([".git"])
  })
})

describe("FileRemove snapshot", () => {
  test("saves work made since the last turn before deleting it, so version history can bring it back", async () => {
    await using tmp = await tmpdir()
    const work = path.join(tmp.path, "project-directory")
    await fs.mkdir(path.join(work, ".git"), { recursive: true })
    await fs.writeFile(path.join(work, ".git", "opencode"), "team-1-project")
    await fs.writeFile(path.join(work, "draft.txt"), "unsaved")
    await Instance.provide({
      directory: work,
      fn: async () => {
        await FileRemove.clear()
      },
    })
    expect(await exists(path.join(work, "draft.txt"))).toBe(false)
    const [saved] = await History.list(work)
    expect(saved?.subject).toBe("파일 삭제 전 자동 저장")
    await History.restore(work, {
      sha: saved!.sha,
      message: (target) => `되돌리기: ${target.subject}`,
      backup: "되돌리기 전 자동 저장",
    })
    expect(await fs.readFile(path.join(work, "draft.txt"), "utf8")).toBe("unsaved")
  })
})
