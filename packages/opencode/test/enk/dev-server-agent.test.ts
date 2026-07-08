import { afterEach, describe, expect, test } from "bun:test"
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

describe("DevServerAgent.shouldAttempt", () => {
  test("빈 디렉토리면 skip", async () => {
    const dir = await tempProjectDir()
    expect(await DevServerAgent.shouldAttempt(dir)).toBe(false)
  })

  test("숨김 항목(.opencode 마커)만 있으면 skip", async () => {
    const dir = await tempProjectDir()
    await mkdir(join(dir, ".opencode"), { recursive: true })
    await writeFile(join(dir, ".opencode/dev-server-agent.json"), JSON.stringify({ attemptedAt: 0 }))
    expect(await DevServerAgent.shouldAttempt(dir)).toBe(false)
  })

  test("정적 결과물(index.html)만 있어도 시도한다", async () => {
    const dir = await tempProjectDir()
    await writeFile(join(dir, "index.html"), "<html></html>")
    expect(await DevServerAgent.shouldAttempt(dir)).toBe(true)
  })

  test("최근 시도 마커가 있으면 쿨다운으로 skip", async () => {
    const dir = await tempProjectDir()
    await writeFile(join(dir, "index.html"), "<html></html>")
    await mkdir(join(dir, ".opencode"), { recursive: true })
    await writeFile(join(dir, ".opencode/dev-server-agent.json"), JSON.stringify({ attemptedAt: Date.now() }))
    expect(await DevServerAgent.shouldAttempt(dir)).toBe(false)
  })

  test("마커가 쿨다운을 지났으면 시도", async () => {
    const dir = await tempProjectDir()
    await writeFile(join(dir, "index.html"), "<html></html>")
    await mkdir(join(dir, ".opencode"), { recursive: true })
    await writeFile(
      join(dir, ".opencode/dev-server-agent.json"),
      JSON.stringify({ attemptedAt: Date.now() - 11 * 60 * 1000 }),
    )
    expect(await DevServerAgent.shouldAttempt(dir)).toBe(true)
  })
})
