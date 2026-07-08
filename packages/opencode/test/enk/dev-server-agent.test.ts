import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:net"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DevServerAgent } from "../../src/enk/dev-server-agent"

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function tempProjectDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dev-server-agent-"))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function withPackageJson(dir: string) {
  await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }))
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

// 미사용 포트 확보 — 리스너를 열어 포트를 할당받고 즉시 닫는다.
async function freePort(): Promise<number> {
  const { server, port } = await listen()
  await close(server)
  return port
}

describe("DevServerAgent.shouldAttempt", () => {
  test("기록 파일이 있으면 replay 담당이므로 skip", async () => {
    const dir = await tempProjectDir()
    await withPackageJson(dir)
    await mkdir(join(dir, ".opencode"), { recursive: true })
    await writeFile(
      join(dir, ".opencode/dev-server.json"),
      JSON.stringify({ cmd: "npm run dev", cwd: dir, port: 3000 }),
    )
    expect(await DevServerAgent.shouldAttempt(dir, await freePort())).toBe(false)
  })

  test("package.json 이 없으면 skip", async () => {
    const dir = await tempProjectDir()
    expect(await DevServerAgent.shouldAttempt(dir, await freePort())).toBe(false)
  })

  test("포트가 이미 LISTEN 중이면 skip", async () => {
    const dir = await tempProjectDir()
    await withPackageJson(dir)
    const { server, port } = await listen()
    cleanups.push(() => close(server))
    expect(await DevServerAgent.shouldAttempt(dir, port)).toBe(false)
  })

  test("최근 시도 마커가 있으면 쿨다운으로 skip", async () => {
    const dir = await tempProjectDir()
    await withPackageJson(dir)
    await mkdir(join(dir, ".opencode"), { recursive: true })
    await writeFile(join(dir, ".opencode/dev-server-agent.json"), JSON.stringify({ attemptedAt: Date.now() }))
    expect(await DevServerAgent.shouldAttempt(dir, await freePort())).toBe(false)
  })

  test("마커가 쿨다운을 지났으면 시도", async () => {
    const dir = await tempProjectDir()
    await withPackageJson(dir)
    await mkdir(join(dir, ".opencode"), { recursive: true })
    await writeFile(
      join(dir, ".opencode/dev-server-agent.json"),
      JSON.stringify({ attemptedAt: Date.now() - 11 * 60 * 1000 }),
    )
    expect(await DevServerAgent.shouldAttempt(dir, await freePort())).toBe(true)
  })

  test("전제 조건이 모두 충족되면 시도", async () => {
    const dir = await tempProjectDir()
    await withPackageJson(dir)
    expect(await DevServerAgent.shouldAttempt(dir, await freePort())).toBe(true)
  })
})
