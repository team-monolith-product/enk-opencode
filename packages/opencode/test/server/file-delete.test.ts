import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { FileRoutes } from "../../src/server/routes/file"
import { Assets } from "../../src/file/assets"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const remove = (target: string) =>
  FileRoutes().request(`/file?path=${encodeURIComponent(target)}`, { method: "DELETE" })

async function inProject(fn: (dir: string) => Promise<void>) {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({ directory: tmp.path, fn: () => fn(tmp.path) })
}

describe("DELETE /file", () => {
  test("deletes a project file", () =>
    inProject(async (dir) => {
      fs.writeFileSync(path.join(dir, "index.html"), "<p>hi</p>")
      const res = await remove("index.html")
      expect(res.status).toBe(200)
      expect(fs.existsSync(path.join(dir, "index.html"))).toBe(false)
    }))

  test("deletes a folder with what is inside it", () =>
    inProject(async (dir) => {
      fs.mkdirSync(path.join(dir, "src", "nested"), { recursive: true })
      fs.writeFileSync(path.join(dir, "src", "nested", "a.ts"), "a")
      expect((await remove("src")).status).toBe(200)
      expect(fs.existsSync(path.join(dir, "src"))).toBe(false)
    }))

  test("treats a missing path as already deleted", () =>
    inProject(async () => {
      expect((await remove("gone/also-gone.txt")).status).toBe(200)
    }))

  test("refreshes the upload folder's cached usage", () =>
    inProject(async (dir) => {
      fs.mkdirSync(Assets.root(), { recursive: true })
      fs.writeFileSync(path.join(Assets.root(), "a.txt"), "12345")
      Assets.snapshot()
      expect((await remove("__assets__/a.txt")).status).toBe(200)
      expect(Assets.claim(0)).toMatchObject({ bytes: 0 })
      expect(Assets.projectedBytes({ bytes: 0 }, 0)).toBe(0)
      expect(fs.existsSync(path.join(dir, "__assets__", "a.txt"))).toBe(false)
    }))

  test.each(["..", "../outside.txt", ".", "sub/..", "/etc/hosts"])("refuses %s", (target) =>
    inProject(async (dir) => {
      const outside = path.join(dir, "..", "outside.txt")
      fs.writeFileSync(outside, "keep")
      fs.writeFileSync(path.join(dir, "keep.txt"), "keep")
      try {
        expect((await remove(target)).status).toBe(400)
        expect(fs.existsSync(outside)).toBe(true)
        expect(fs.existsSync(path.join(dir, "keep.txt"))).toBe(true)
      } finally {
        fs.rmSync(outside, { force: true })
      }
    }),
  )

  test("refuses the git directory", () =>
    inProject(async (dir) => {
      expect((await remove(".git")).status).toBe(400)
      expect((await remove(".git/config")).status).toBe(400)
      expect(fs.existsSync(path.join(dir, ".git", "config"))).toBe(true)
    }))

  test("refuses a path that leaves the project through a symlinked folder", async () => {
    await using outside = await tmpdir()
    fs.writeFileSync(path.join(outside.path, "secret.txt"), "keep")
    await inProject(async (dir) => {
      fs.symlinkSync(outside.path, path.join(dir, "link"))
      expect((await remove("link/secret.txt")).status).toBe(400)
      expect(fs.existsSync(path.join(outside.path, "secret.txt"))).toBe(true)
    })
  })

  test("removes the link itself, not the folder it points to", async () => {
    await using outside = await tmpdir()
    fs.writeFileSync(path.join(outside.path, "secret.txt"), "keep")
    await inProject(async (dir) => {
      fs.symlinkSync(outside.path, path.join(dir, "link"))
      expect((await remove("link")).status).toBe(200)
      expect(fs.existsSync(path.join(dir, "link"))).toBe(false)
      expect(fs.existsSync(path.join(outside.path, "secret.txt"))).toBe(true)
    })
  })
})
