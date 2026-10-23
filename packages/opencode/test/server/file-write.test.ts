import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { createHash } from "crypto"
import { FileRoutes } from "../../src/server/routes/file"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const write = (target: string, body: BodyInit, expected?: string) =>
  FileRoutes().request(`/file/content?path=${encodeURIComponent(target)}${expected ? `&expected=${expected}` : ""}`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body,
  })

describe("PUT /file/content", () => {
  test("replaces the bytes of an existing file", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, "images", "logo.png")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, "old")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255])
        const res = await write("images/logo.png", bytes)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ path: "images/logo.png", size: bytes.length })
        expect(new Uint8Array(fs.readFileSync(file))).toEqual(bytes)
        // No temp file is left next to it.
        expect(fs.readdirSync(path.dirname(file))).toEqual(["logo.png"])
      },
    })
  })

  test("keeps the file's permission bits", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, "a.png")
    fs.writeFileSync(file, "old")
    // 0664 는 흔한 umask 022 에 걸리는 권한이라, open() 의 mode 만 믿으면 0644 로 바뀐다.
    fs.chmodSync(file, 0o664)
    const umask = process.umask(0o022)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await write("a.png", "new")).status).toBe(200)
        expect(fs.statSync(file).mode & 0o777).toBe(0o664)
      },
    }).finally(() => process.umask(umask))
  })

  test("writes only when the file still matches the expected hash", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, "a.png")
    fs.writeFileSync(file, "opened")
    const opened = createHash("sha256").update("opened").digest("hex")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // 편집기를 연 뒤 다른 곳에서 바뀌었다: 거절하고 그 변경을 지키지 않는다.
        fs.writeFileSync(file, "changed elsewhere")
        const conflict = await write("a.png", "edit", opened)
        expect(conflict.status).toBe(409)
        expect(fs.readFileSync(file, "utf8")).toBe("changed elsewhere")
        expect(fs.readdirSync(tmp.path).filter((name) => name.endsWith(".tmp"))).toEqual([])

        // 그대로면 쓴다.
        const current = createHash("sha256").update("changed elsewhere").digest("hex")
        expect((await write("a.png", "edit", current)).status).toBe(200)
        expect(fs.readFileSync(file, "utf8")).toBe("edit")
      },
    })
  })

  test("refuses to create a file that does not exist", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await write("new.png", "data")).status).toBe(400)
        expect(fs.existsSync(path.join(tmp.path, "new.png"))).toBe(false)
      },
    })
  })

  test("refuses a path that escapes the project", async () => {
    await using tmp = await tmpdir({ git: true })
    await using outside = await tmpdir()
    const victim = path.join(outside.path, "victim.png")
    fs.writeFileSync(victim, "keep")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const relative = path.relative(tmp.path, victim)
        expect((await write(relative, "pwned")).status).toBe(400)
        expect((await write(victim, "pwned")).status).toBe(400)
        expect(fs.readFileSync(victim, "utf8")).toBe("keep")
      },
    })
  })

  test("refuses a symlink inside the project that points outside it", async () => {
    await using tmp = await tmpdir({ git: true })
    await using outside = await tmpdir()
    const victim = path.join(outside.path, "victim.png")
    fs.writeFileSync(victim, "keep")
    fs.symlinkSync(victim, path.join(tmp.path, "link.png"))

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await write("link.png", "pwned")).status).toBe(400)
        expect(fs.readFileSync(victim, "utf8")).toBe("keep")
      },
    })
  })

  test("refuses git internals, secret env files and directories", async () => {
    await using tmp = await tmpdir({ git: true })
    fs.writeFileSync(path.join(tmp.path, ".env"), "KEY=secret")
    fs.mkdirSync(path.join(tmp.path, "dir"))

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await write(".git/config", "pwned")).status).toBe(400)
        expect((await write(".env", "KEY=other")).status).toBe(400)
        expect((await write("dir", "data")).status).toBe(400)
        expect(fs.readFileSync(path.join(tmp.path, ".env"), "utf8")).toBe("KEY=secret")
        expect(fs.readFileSync(path.join(tmp.path, ".git", "config"), "utf8")).not.toBe("pwned")
      },
    })
  })
})
