import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { mkdir, writeFile } from "node:fs/promises"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const ORIGINAL_ENV = process.env["ENK_PROJECT_DIRECTORY"]

afterEach(async () => {
  if (ORIGINAL_ENV === undefined) delete process.env["ENK_PROJECT_DIRECTORY"]
  else process.env["ENK_PROJECT_DIRECTORY"] = ORIGINAL_ENV
  await resetDatabase()
})

async function write(dir: string, file: string, content: string) {
  await mkdir(path.join(dir, ".opencode"), { recursive: true })
  await writeFile(path.join(dir, ".opencode", file), content)
}

describe("GET /dev-server/logs", () => {
  test("returns the log tail with the recorded command", async () => {
    await using tmp = await tmpdir()
    delete process.env["ENK_PROJECT_DIRECTORY"]
    await write(tmp.path, "dev-server.json", JSON.stringify({ cmd: "npm run dev", cwd: tmp.path, port: 3000 }))
    await write(tmp.path, "dev-server.log", "starting\nready in 300ms\n")

    const res = await Server.Default().request("/dev-server/logs", {
      headers: { "x-opencode-directory": tmp.path },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ lines: ["starting", "ready in 300ms"], cmd: "npm run dev", port: 3000 })
  })

  test("honors the tail query and keeps the newest lines", async () => {
    await using tmp = await tmpdir()
    delete process.env["ENK_PROJECT_DIRECTORY"]
    await write(tmp.path, "dev-server.log", "a\nb\nc\n")

    const res = await Server.Default().request("/dev-server/logs?tail=2", {
      headers: { "x-opencode-directory": tmp.path },
    })

    expect(await res.json()).toMatchObject({ lines: ["b", "c"] })
  })

  test("returns an empty tail when no dev server has run", async () => {
    await using tmp = await tmpdir()
    delete process.env["ENK_PROJECT_DIRECTORY"]

    const res = await Server.Default().request("/dev-server/logs", {
      headers: { "x-opencode-directory": tmp.path },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ lines: [] })
  })
})
