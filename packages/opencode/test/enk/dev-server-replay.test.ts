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
    test("writes the state file under .opencode in the project directory", async () => {
      const dir = await tempProjectDir()
      const state = { cmd: "npm run dev -- --port 3000", cwd: dir, port: 3000 }

      await DevServerReplay.record(dir, state)

      const raw = await readFile(join(dir, ".opencode", "dev-server.json"), "utf8")
      expect(JSON.parse(raw)).toEqual(state)
    })
  })

  describe("replay", () => {
    test("does nothing when ENK_PROJECT_DIRECTORY is not set", async () => {
      const dir = await tempProjectDir()
      const marker = join(dir, "marker")
      await writeState(dir, { cmd: `echo ok > ${marker}`, cwd: dir, port: await freePort() })

      delete process.env["ENK_PROJECT_DIRECTORY"]
      await DevServerReplay.replay()

      await new Promise((r) => setTimeout(r, 200))
      expect(existsSync(marker)).toBe(false)
    })

    test("does nothing when the state file is missing", async () => {
      const dir = await tempProjectDir()
      process.env["ENK_PROJECT_DIRECTORY"] = dir

      await DevServerReplay.replay()
    })

    test("replays the recorded command", async () => {
      const dir = await tempProjectDir()
      const marker = join(dir, "marker")
      await writeState(dir, { cmd: `echo ok > ${marker}`, cwd: dir, port: await freePort() })

      process.env["ENK_PROJECT_DIRECTORY"] = dir
      await DevServerReplay.replay()

      expect(await waitFor(() => existsSync(marker))).toBe(true)
    })

    test("skips replay when the port is already listening", async () => {
      const dir = await tempProjectDir()
      const marker = join(dir, "marker")
      const { server, port } = await listen()
      cleanups.push(() => close(server))
      await writeState(dir, { cmd: `echo ok > ${marker}`, cwd: dir, port })

      process.env["ENK_PROJECT_DIRECTORY"] = dir
      await DevServerReplay.replay()

      await new Promise((r) => setTimeout(r, 200))
      expect(existsSync(marker)).toBe(false)
    })

    test("skips replay when the recorded cwd no longer exists", async () => {
      const dir = await tempProjectDir()
      const marker = join(dir, "marker")
      await writeState(dir, { cmd: `echo ok > ${marker}`, cwd: join(dir, "gone"), port: await freePort() })

      process.env["ENK_PROJECT_DIRECTORY"] = dir
      await DevServerReplay.replay()

      await new Promise((r) => setTimeout(r, 200))
      expect(existsSync(marker)).toBe(false)
    })
  })
})
