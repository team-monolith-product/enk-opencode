import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:net"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DevServerBoot } from "../../src/enk/dev-server-boot"
import type { DevServerReplay } from "../../src/enk/dev-server-replay"

const ORIGINAL_ENV = process.env["ENK_PROJECT_DIRECTORY"]
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  if (ORIGINAL_ENV === undefined) delete process.env["ENK_PROJECT_DIRECTORY"]
  else process.env["ENK_PROJECT_DIRECTORY"] = ORIGINAL_ENV
  while (cleanups.length) await cleanups.pop()!()
})

// teams/{id}/{project,tutorial}-directory 형태의 워크스페이스.
// 테스트 디렉토리에는 package.json 을 두지 않아 AI 폴백(DevServerAgent)이
// shouldAttempt 게이트에서 멈춘다 — boot 의 재실행 경로만 검증한다.
async function tempWorkspace(): Promise<{ project: string; tutorial: string }> {
  const root = await mkdtemp(join(tmpdir(), "dev-server-boot-"))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const project = join(root, "project-directory")
  const tutorial = join(root, "tutorial-directory")
  await mkdir(project, { recursive: true })
  await mkdir(tutorial, { recursive: true })
  return { project, tutorial }
}

async function writeState(dir: string, state: DevServerReplay.State) {
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(join(dir, ".opencode", "dev-server.json"), JSON.stringify(state))
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

describe("DevServerBoot.boot", () => {
  test("does nothing when ENK_PROJECT_DIRECTORY is not set", async () => {
    const { project } = await tempWorkspace()
    const marker = join(project, "marker")
    await writeState(project, { cmd: `echo ok > ${marker}`, cwd: project, port: await freePort() })

    delete process.env["ENK_PROJECT_DIRECTORY"]
    await DevServerBoot.boot()

    await new Promise((r) => setTimeout(r, 200))
    expect(existsSync(marker)).toBe(false)
  })

  test("replays project and tutorial records independently", async () => {
    const { project, tutorial } = await tempWorkspace()
    const projectMarker = join(project, "marker")
    const tutorialMarker = join(tutorial, "marker")
    await writeState(project, { cmd: `echo ok > ${projectMarker}`, cwd: project, port: await freePort() })
    await writeState(tutorial, { cmd: `echo ok > ${tutorialMarker}`, cwd: tutorial, port: await freePort() })

    process.env["ENK_PROJECT_DIRECTORY"] = project
    await DevServerBoot.boot()

    expect(await waitFor(() => existsSync(projectMarker))).toBe(true)
    expect(await waitFor(() => existsSync(tutorialMarker))).toBe(true)
  })

  test("skips replay when the port is already listening", async () => {
    const { project } = await tempWorkspace()
    const marker = join(project, "marker")
    const { server, port } = await listen()
    cleanups.push(() => close(server))
    await writeState(project, { cmd: `echo ok > ${marker}`, cwd: project, port })

    process.env["ENK_PROJECT_DIRECTORY"] = project
    await DevServerBoot.boot()

    await new Promise((r) => setTimeout(r, 200))
    expect(existsSync(marker)).toBe(false)
  })

  test("does not replay a record whose cwd belongs to another target", async () => {
    const { project, tutorial } = await tempWorkspace()
    const marker = join(project, "marker")
    // 규약 이전에 남은 기록 — 본행사 파일에 튜토리얼 cwd. 재실행 대신 폴백 경로로
    // 넘어가야 하며(여기선 package.json 이 없어 폴백도 조용히 멈춘다) launch 되면 안 된다.
    await writeState(project, { cmd: `echo ok > ${marker}`, cwd: tutorial, port: await freePort() })

    process.env["ENK_PROJECT_DIRECTORY"] = project
    await DevServerBoot.boot()

    await new Promise((r) => setTimeout(r, 200))
    expect(existsSync(marker)).toBe(false)
  })
})
