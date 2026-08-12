import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:net"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DevServerReplay, probePort } from "../../src/enk/dev-server-replay"

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

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return predicate()
}

/** 별도 프로세스에서 포트를 잡는 더미 서버. launch 와 동일하게 detached 로 떠 pgid == pid. */
async function spawnListener(dir: string, port: number) {
  const child = DevServerReplay.launch(
    `${process.execPath} -e 'require("net").createServer().listen(${port}, "127.0.0.1"); setInterval(() => {}, 1000)'`,
    dir,
  )
  cleanups.push(async () => {
    try {
      process.kill(-child.pid!, "SIGKILL")
    } catch {}
  })
  return child
}

// teams/{id}/{project,tutorial}-directory 형태의 워크스페이스. 본행사를 env 로 주입한다.
async function tempWorkspace(): Promise<{ project: string; tutorial: string }> {
  const root = await tempProjectDir()
  const project = join(root, "project-directory")
  const tutorial = join(root, "tutorial-directory")
  await mkdir(project, { recursive: true })
  await mkdir(tutorial, { recursive: true })
  process.env["ENK_PROJECT_DIRECTORY"] = project
  return { project, tutorial }
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

    test("본행사 하위 폴더에서 띄워도 타깃 폴더 한 곳에 기록한다", async () => {
      const { project } = await tempWorkspace()
      const session = join(project, "app")
      await mkdir(session, { recursive: true })
      const state = { cmd: "npm run dev -- --port 3000", cwd: session, port: 3000 }

      await DevServerReplay.record(session, state)

      const raw = await readFile(join(project, ".opencode", "dev-server.json"), "utf8")
      expect(JSON.parse(raw)).toEqual(state)
      expect(existsSync(join(session, ".opencode", "dev-server.json"))).toBe(false)
    })

    test("튜토리얼 cwd 의 기록은 본행사가 아니라 튜토리얼 폴더에 쓴다", async () => {
      const { project, tutorial } = await tempWorkspace()
      const state = { cmd: "npm run dev -- --port 3001", cwd: tutorial, port: 3001 }

      await DevServerReplay.record(project, state)

      const raw = await readFile(join(tutorial, ".opencode", "dev-server.json"), "utf8")
      expect(JSON.parse(raw)).toEqual(state)
      expect(existsSync(join(project, ".opencode", "dev-server.json"))).toBe(false)
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

    test("records the pid of the replayed process so it can be stopped later", async () => {
      const dir = await tempProjectDir()
      const port = await freePort()
      await writeState(dir, { cmd: `sleep 30`, cwd: dir, port })

      process.env["ENK_PROJECT_DIRECTORY"] = dir
      await DevServerReplay.replay()

      const recorded = await DevServerReplay.loadRecord(dir)
      expect(recorded?.pid).toBeGreaterThan(0)
      cleanups.push(async () => {
        try {
          process.kill(-recorded!.pid!, "SIGKILL")
        } catch {}
      })
    })

    test("본행사 기록이 튜토리얼 cwd 를 가리키면 재실행하지 않는다", async () => {
      const { project, tutorial } = await tempWorkspace()
      const marker = join(project, "marker")
      await writeState(project, { cmd: `echo ok > ${marker}`, cwd: tutorial, port: await freePort() })

      await DevServerReplay.replay()

      await new Promise((r) => setTimeout(r, 200))
      expect(existsSync(marker)).toBe(false)
    })

    test("튜토리얼 기록은 부팅 때 되살리지 않는다", async () => {
      const { tutorial } = await tempWorkspace()
      const marker = join(tutorial, "marker")
      await writeState(tutorial, { cmd: `echo ok > ${marker}`, cwd: tutorial, port: await freePort() })

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

  describe("launch log capture", () => {
    // 로그가 파일에 닿을 때까지(=readLog 가 기대 줄을 볼 때까지) 기다린다. launch 는 fire-and-forget 이라
    // 쓰기 시점이 비동기다.
    async function waitForLog(dir: string, predicate: (lines: string[]) => boolean, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs
      let lines = await DevServerReplay.readLog({ dir })
      while (!predicate(lines) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50))
        lines = await DevServerReplay.readLog({ dir })
      }
      return lines
    }

    test("captures stdout and stderr into the log file", async () => {
      const dir = await tempProjectDir()

      DevServerReplay.launch("echo out; echo err 1>&2", dir, { dir })

      expect(await waitForLog(dir, (l) => l.includes("out") && l.includes("err"))).toEqual(["out", "err"])
    })

    test("redirects the whole command when it is compound", async () => {
      const dir = await tempProjectDir()

      DevServerReplay.launch("echo first && echo second", dir, { dir })

      expect(await waitForLog(dir, (l) => l.length >= 2)).toEqual(["first", "second"])
    })

    test("truncates the log on each launch so only the current run shows", async () => {
      const dir = await tempProjectDir()

      DevServerReplay.launch("echo old", dir, { dir })
      await waitForLog(dir, (l) => l.includes("old"))
      DevServerReplay.launch("echo new", dir, { dir })

      expect(await waitForLog(dir, (l) => l.includes("new"))).toEqual(["new"])
    })

    test("strips ANSI colors and collapses carriage-return progress lines", async () => {
      const dir = await tempProjectDir()

      DevServerReplay.launch(`printf '\\033[32mready\\033[0m\\n10%%\\r90%%\\rdone\\n'`, dir, { dir })

      expect(await waitForLog(dir, (l) => l.includes("done"))).toEqual(["ready", "done"])
    })

    test("keeps only the last requested lines", async () => {
      const dir = await tempProjectDir()

      DevServerReplay.launch("for i in 1 2 3 4 5; do echo line$i; done", dir, { dir })

      expect(await waitForLog(dir, (l) => l.includes("line5"))).toHaveLength(5)
      expect(await DevServerReplay.readLog({ dir, lines: 2 })).toEqual(["line4", "line5"])
    })

    test("returns nothing when no log exists", async () => {
      const dir = await tempProjectDir()

      expect(await DevServerReplay.readLog({ dir })).toEqual([])
    })

    test("본행사 하위 폴더에서 띄워도 기록과 같은 타깃 폴더에 로그를 쓴다", async () => {
      const { project } = await tempWorkspace()
      const session = join(project, "app")
      await mkdir(session, { recursive: true })

      DevServerReplay.launch("echo ok", session)

      expect(await waitForLog(project, (l) => l.includes("ok"))).toEqual(["ok"])
      expect(existsSync(join(session, ".opencode", "dev-server.log"))).toBe(false)
    })

    test("튜토리얼 로그는 본행사 로그와 섞이지 않는다", async () => {
      const { project, tutorial } = await tempWorkspace()

      DevServerReplay.launch("echo 튜토리얼", tutorial)

      expect(await waitForLog(tutorial, (l) => l.includes("튜토리얼"))).toEqual(["튜토리얼"])
      expect(await DevServerReplay.readLog({ dir: project })).toEqual([])
    })
  })

  describe("loadRecord", () => {
    test("cwd 가 속한 타깃의 기록을 읽는다", async () => {
      const { project, tutorial } = await tempWorkspace()
      await writeState(project, { cmd: "본행사", cwd: project, port: 3000 })
      await writeState(tutorial, { cmd: "튜토리얼", cwd: tutorial, port: 3001 })

      expect((await DevServerReplay.loadRecord(join(project, "src")))?.cmd).toBe("본행사")
      expect((await DevServerReplay.loadRecord(join(tutorial, "src")))?.cmd).toBe("튜토리얼")
    })

    test("다른 타깃의 cwd 를 서술하는 기록은 없는 것으로 본다", async () => {
      const { project, tutorial } = await tempWorkspace()
      await writeState(project, { cmd: "튜토리얼", cwd: tutorial, port: 3000, pid: 1234 })

      expect(await DevServerReplay.loadRecord(project)).toBeUndefined()
    })
  })

  describe("stop", () => {
    test("succeeds trivially when nothing is listening", async () => {
      expect(await DevServerReplay.stop(await freePort(), undefined, 500)).toBe(true)
    })

    test("kills the recorded process group and frees the port", async () => {
      const dir = await tempProjectDir()
      const port = await freePort()
      // 셸(/bin/sh -lc)이 부모, 실제 listener 가 자식 — 그룹째 죽어야 포트가 풀린다.
      const child = await spawnListener(dir, port)
      expect(await waitForAsync(() => probePort(port))).toBe(true)

      expect(await DevServerReplay.stop(port, child.pid, 3000)).toBe(true)
      expect(await probePort(port)).toBe(false)
    })

    test("reports failure when the port holder cannot be identified", async () => {
      // 이 테스트 프로세스가 직접 잡은 포트 — 기록된 pid 도 없고, /proc 폴백은 자기 자신을 건너뛴다.
      const { server, port } = await listen()
      cleanups.push(() => close(server))

      expect(await DevServerReplay.stop(port, undefined, 500)).toBe(false)
      expect(await probePort(port)).toBe(true)
    })
  })
})
