import { test, expect, describe } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { FileRemove } from "../../src/file/remove"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

async function seed(dir: string) {
  await fs.mkdir(path.join(dir, "src/deep"), { recursive: true })
  await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
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
        expect(await FileRemove.resolve(".opencode/keep.json")).toBeUndefined()
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

  test("clear deletes everything except protected folders", async () => {
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
    expect(await exists(path.join(tmp.path, ".opencode/keep.json"))).toBe(true)
  })
})
