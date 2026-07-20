import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:net"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DevServerReplay } from "../../src/enk/dev-server-replay"

const ORIGINAL_ENV = process.env["ENK_PROJECT_DIRECTORY"]
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  if (ORIGINAL_ENV === undefined) delete process.env["ENK_PROJECT_DIRECTORY"]
  else process.env["ENK_PROJECT_DIRECTORY"] = ORIGINAL_ENV
  while (cleanups.length) await cleanups.pop()!()
})

async function tempProjectDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dev-server-replay-"))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function listen(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      if (!addr || typeof addr === "string") {
        server.close()
        reject(new Error("expected TCP address"))
        return
      }
      resolve({ server, port: addr.port })
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

async function freePort(): Promise<number> {
  const { server, port } = await listen()
  await close(server)
  return port
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return predicate()
}

async function writeState(projectDir: string, state: DevServerReplay.State) {
  const file = join(projectDir, ".opencode", "dev-server.json")
  await mkdir(join(projectDir, ".opencode"), { recursive: true })
  await writeFile(file, JSON.stringify(state))
}

describe("DevServerReplay", () => {
  describe("record", () => {
    test("writes the state file under .opencode in the fallback directory", async () => {
      const dir = await tempProjectDir()
      const state = { cmd: "npm run dev -- --port 3000", cwd: dir, port: 3000 }

      await DevServerReplay.record(dir, state)

      const raw = await readFile(join(dir, ".opencode", "dev-server.json"), "utf8")
      expect(JSON.parse(raw)).toEqual(state)
    })

    test("prefers ENK_PROJECT_DIRECTORY over the fallback so record and replay agree", async () => {
      const canonical = await tempProjectDir()
      const session = await tempProjectDir()
      const state = { cmd: "npm run dev -- --port 3000", cwd: session, port: 3000 }

      process.env["ENK_PROJECT_DIRECTORY"] = canonical
      await DevServerReplay.record(session, state)

      const raw = await readFile(join(canonical, ".opencode", "dev-server.json"), "utf8")
      expect(JSON.parse(raw)).toEqual(state)
      expect(existsSync(join(session, ".opencode", "dev-server.json"))).toBe(false)
    })
  })

  describe("start", () => {
    // launch 후 LISTEN 을 기다리는 시간 — 테스트 커맨드는 포트를 열지 않으므로 짧게 잡는다.
    const READY = 300

    test("reports no_command when ENK_PROJECT_DIRECTORY is not set", async () => {
      const dir = await tempProjectDir()
      const marker = join(dir, "marker")
      await writeState(dir, { cmd: `echo ok > ${marker}`, cwd: dir, port: await freePort() })

      delete process.env["ENK_PROJECT_DIRECTORY"]
      const result = await DevServerReplay.start({ readyTimeoutMs: READY })

      expect(result.status).toBe("no_command")
      await new Promise((r) => setTimeout(r, 200))
      expect(existsSync(marker)).toBe(false)
    })

    test("reports no_command when the state file is missing", async () => {
      const dir = await tempProjectDir()
      process.env["ENK_PROJECT_DIRECTORY"] = dir

      expect((await DevServerReplay.start({ readyTimeoutMs: READY })).status).toBe("no_command")
    })

    test("launches the recorded command", async () => {
      const dir = await tempProjectDir()
      const marker = join(dir, "marker")
      await writeState(dir, { cmd: `echo ok > ${marker}`, cwd: dir, port: await freePort() })

      process.env["ENK_PROJECT_DIRECTORY"] = dir
      await DevServerReplay.start({ readyTimeoutMs: READY })

      expect(await waitFor(() => existsSync(marker))).toBe(true)
    })

    test("reports started once the recorded port begins listening", async () => {
      const dir = await tempProjectDir()
      const port = await freePort()
      // launch 가 실제로 포트를 열어야 started 가 나온다 — 짧게 LISTEN 하는 커맨드를 기록한다.
      const cmd = `bun -e 'require("net").createServer().listen(${port}, "127.0.0.1", () => setTimeout(() => process.exit(0), 3000))'`
      await writeState(dir, { cmd, cwd: dir, port })

      process.env["ENK_PROJECT_DIRECTORY"] = dir
      const result = await DevServerReplay.start({ readyTimeoutMs: 8000 })

      expect(result.status).toBe("started")
      expect(result.port).toBe(port)
    })

    test("reports already_running without launching when the port is listening", async () => {
      const dir = await tempProjectDir()
      const marker = join(dir, "marker")
      const { server, port } = await listen()
      cleanups.push(() => close(server))
      await writeState(dir, { cmd: `echo ok > ${marker}`, cwd: dir, port })

      process.env["ENK_PROJECT_DIRECTORY"] = dir
      const result = await DevServerReplay.start({ readyTimeoutMs: READY })

      expect(result.status).toBe("already_running")
      await new Promise((r) => setTimeout(r, 200))
      expect(existsSync(marker)).toBe(false)
    })

    test("fails without launching when the recorded cwd no longer exists", async () => {
      const dir = await tempProjectDir()
      const marker = join(dir, "marker")
      await writeState(dir, { cmd: `echo ok > ${marker}`, cwd: join(dir, "gone"), port: await freePort() })

      process.env["ENK_PROJECT_DIRECTORY"] = dir
      const result = await DevServerReplay.start({ readyTimeoutMs: READY })

      expect(result.status).toBe("failed")
      await new Promise((r) => setTimeout(r, 200))
      expect(existsSync(marker)).toBe(false)
    })

    test("reports already_starting for a concurrent call and exposes isLaunching", async () => {
      const dir = await tempProjectDir()
      const marker = join(dir, "marker")
      await writeState(dir, { cmd: `echo ok > ${marker}`, cwd: dir, port: await freePort() })

      process.env["ENK_PROJECT_DIRECTORY"] = dir
      const first = DevServerReplay.start({ readyTimeoutMs: 1000 })
      await waitFor(() => DevServerReplay.isLaunching(), 1000)
      expect(DevServerReplay.isLaunching()).toBe(true)

      expect((await DevServerReplay.start({ readyTimeoutMs: READY })).status).toBe("already_starting")

      await first
      expect(DevServerReplay.isLaunching()).toBe(false)
    })
  })
})
