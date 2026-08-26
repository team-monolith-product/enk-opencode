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

const upload = (target: string, body: BodyInit) =>
  FileRoutes().request(`/file/asset?path=${encodeURIComponent(target)}`, {
    method: "POST",
    body,
  })

const list = () => FileRoutes().request("/file/asset")

const remove = (target?: string) =>
  FileRoutes().request(target === undefined ? "/file/asset" : `/file/asset?path=${encodeURIComponent(target)}`, {
    method: "DELETE",
  })

describe("POST /file/asset", () => {
  test("stores the bytes verbatim under the upload folder", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const res = await upload("notes.txt", "hello world")
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ path: "notes.txt", size: 11 })

        const stored = path.join(Assets.root(), "notes.txt")
        expect(fs.readFileSync(stored, "utf8")).toBe("hello world")
      },
    })
  })

  test("keeps the directory shape of a folder upload", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const res = await upload("docs/spec/api.md", "# api")
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ path: "docs/spec/api.md" })
        expect(fs.readFileSync(path.join(Assets.root(), "docs", "spec", "api.md"), "utf8")).toBe("# api")
      },
    })
  })

  test("keeps a non-ascii filename intact", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const res = await upload("설계안.md", "내용")
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ path: "설계안.md" })
      },
    })
  })

  test("rejects a path that escapes the upload folder, writing nothing", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const res = await upload("../../escape.txt", "pwned")
        expect(res.status).toBe(400)
        expect(fs.existsSync(path.join(tmp.path, "..", "escape.txt"))).toBe(false)
        expect(fs.existsSync(path.join(tmp.path, "escape.txt"))).toBe(false)
      },
    })
  })

  test("does not overwrite an existing upload", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await upload("a.txt", "first")
        const res = await upload("a.txt", "second")
        expect(await res.json()).toMatchObject({ path: "a (2).txt" })
        expect(fs.readFileSync(path.join(Assets.root(), "a.txt"), "utf8")).toBe("first")
        expect(fs.readFileSync(path.join(Assets.root(), "a (2).txt"), "utf8")).toBe("second")
      },
    })
  })

  test("adds the folder to .git/info/exclude and leaves .gitignore alone", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await upload("a.txt", "x")
        const exclude = fs.readFileSync(path.join(Instance.worktree, ".git", "info", "exclude"), "utf8")
        expect(exclude).toContain(Assets.DIR + "/")

        const gitignore = path.join(Instance.worktree, ".gitignore")
        expect(fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8") : "").not.toContain(Assets.DIR)
      },
    })
  })

  test("rejects a body over the per-file cap and leaves no partial file behind", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Declared up front: rejected before a byte is written.
        const res = await FileRoutes().request("/file/asset?path=big.bin", {
          method: "POST",
          headers: { "content-length": String(Assets.MAX_FILE_BYTES + 1) },
          body: "x",
        })
        expect(res.status).toBe(400)
        expect(fs.existsSync(path.join(Assets.root(), "big.bin"))).toBe(false)
      },
    })
  })

  test("rejects an empty path", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const res = await FileRoutes().request("/file/asset?path=", { method: "POST", body: "x" })
        expect(res.status).toBe(400)
      },
    })
  })
})

describe("GET /file/asset", () => {
  test("reports what is stored and the limits", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await upload("a.txt", "12345")
        await upload("docs/b.txt", "123")

        const body = (await (await list()).json()) as any
        expect(body.files.map((f: any) => f.path)).toEqual(["a.txt", "docs/b.txt"])
        expect(body.usage).toEqual({ count: 2, bytes: 8 })
        expect(body.limits.file).toBe(Assets.MAX_FILE_BYTES)
      },
    })
  })

  test("reads as empty before anything is uploaded", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const body = (await (await list()).json()) as any
        expect(body.files).toEqual([])
        expect(body.usage).toEqual({ count: 0, bytes: 0 })
      },
    })
  })
})

describe("DELETE /file/asset", () => {
  test("deletes one file", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await upload("a.txt", "x")
        await upload("b.txt", "y")
        expect((await remove("a.txt")).status).toBe(200)

        const body = (await (await list()).json()) as any
        expect(body.files.map((f: any) => f.path)).toEqual(["b.txt"])
      },
    })
  })

  test("deletes the whole folder when no path is given", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await upload("a.txt", "x")
        expect((await remove()).status).toBe(200)
        expect(fs.existsSync(Assets.root())).toBe(false)
      },
    })
  })

  test("refuses to delete outside the upload folder", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const victim = path.join(tmp.path, "important.txt")
        fs.writeFileSync(victim, "keep me")

        const res = await remove("../important.txt")
        expect(res.status).toBe(400)
        expect(fs.existsSync(victim)).toBe(true)
      },
    })
  })
})
