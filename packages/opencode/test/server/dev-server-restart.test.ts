import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { createServer } from "node:net"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { Server } from "../../src/server/server"
import { DevServerReplay } from "../../src/enk/dev-server-replay"
import { Log } from "../../src/util/log"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const ORIGINAL_ENV = process.env["ENK_PROJECT_DIRECTORY"]
const pids: number[] = []

afterEach(async () => {
  while (pids.length) {
    try {
      process.kill(-pids.pop()!, "SIGKILL")
    } catch {}
  }
  if (ORIGINAL_ENV === undefined) delete process.env["ENK_PROJECT_DIRECTORY"]
  else process.env["ENK_PROJECT_DIRECTORY"] = ORIGINAL_ENV
  await resetDatabase()
})

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      server.close(() => (addr && typeof addr !== "string" ? resolve(addr.port) : reject(new Error("no port"))))
    })
  })
}

describe("부팅 replay 가 포트를 열기 전 미리보기 요청", () => {
  test("상태는 starting 이고 재시작은 같은 명령을 다시 띄우지 않는다", async () => {
    await using tmp = await tmpdir()
    delete process.env["ENK_PROJECT_DIRECTORY"]
    const marker = path.join(tmp.path, "marker")
    const port = await freePort()
    const cmd = `echo run >> '${marker}'; sleep 30`
    await mkdir(path.join(tmp.path, ".opencode"), { recursive: true })
    await writeFile(path.join(tmp.path, ".opencode", "dev-server.json"), JSON.stringify({ cmd, cwd: tmp.path, port }))

    const boot = await DevServerReplay.launch(cmd, tmp.path, { dir: tmp.path, port })
    pids.push(boot.pid!)

    const headers = { "x-opencode-directory": tmp.path }
    const status = await Server.Default().request("/dev-server/status", { headers })
    expect(await status.json()).toEqual({ state: "starting", port })

    const restart = await Server.Default().request("/dev-server/restart", { method: "POST", headers })
    expect(await restart.json()).toMatchObject({ status: "already_starting", port })

    await Bun.sleep(300)
    expect(existsSync(marker)).toBe(true)
    expect((await readFile(marker, "utf8")).trim().split("\n")).toEqual(["run"])
  })
})
