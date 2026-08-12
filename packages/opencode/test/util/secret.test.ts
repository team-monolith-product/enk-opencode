import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { Secret } from "../../src/util/secret"

afterEach(() => Secret.reset())

async function project(env: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "secret-"))
  await writeFile(path.join(dir, ".env"), env)
  return dir
}

describe("Secret", () => {
  test("removes .env values from tool output", async () => {
    const dir = await project("OPENAI_API_KEY=sk-proj-9f2b1c7d4e8a\n")
    const out = await Secret.redact('fetch failed: {"key":"sk-proj-9f2b1c7d4e8a"}', dir)
    expect(out).not.toContain("sk-proj-9f2b1c7d4e8a")
    expect(out).toContain("[redacted]")
  })

  test("leaves short and word-like values alone", async () => {
    const dir = await project("PORT=3000\nNODE_ENV=development\nDB_USER=postgres\nHOST=localhost\n")
    const text = "listening on 3000 as postgres@localhost in development"
    expect(await Secret.redact(text, dir)).toBe(text)
  })

  test("redacts a short value once it looks like a token", async () => {
    const dir = await project("PASSWORD=p@ssw0rd1\n")
    expect(await Secret.redact("login p@ssw0rd1", dir)).toBe("login [redacted]")
  })

  test("longer values are removed before their substrings", () => {
    // 정렬이 없으면 짧은 값이 긴 값의 일부를 먼저 갉아 긴 값의 나머지가 그대로 남는다
    const out = Secret.apply("token=abcdef123456789 short=abcdef123456", ["abcdef123456789", "abcdef123456"])
    expect(out).toBe("token=[redacted] short=[redacted]")
  })

  test("handles quoted values and every .env variant", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "secret-"))
    await writeFile(path.join(dir, ".env"), 'TOKEN="quoted secret value"\n')
    await writeFile(path.join(dir, ".env.local"), "OTHER=another-secret-1234\n")
    await writeFile(path.join(dir, ".env.example"), "SAMPLE=example-value-1234\n")
    const out = await Secret.redact("quoted secret value / another-secret-1234 / example-value-1234", dir)
    expect(out).not.toContain("quoted secret value")
    expect(out).not.toContain("another-secret-1234")
    // .env.example 은 시크릿이 아니라 그대로 둔다
    expect(out).toContain("example-value-1234")
  })

  test("is a no-op when the project has no .env", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "secret-"))
    expect(await Secret.redact("nothing to hide", dir)).toBe("nothing to hide")
  })
})
