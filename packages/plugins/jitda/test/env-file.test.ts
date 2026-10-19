import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EnvFile } from "../src/env-file"

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})
async function envFile() {
  const dir = await mkdtemp(path.join(tmpdir(), "jitda-env-file-"))
  dirs.push(dir)
  return path.join(dir, ".env")
}

describe("EnvFile.isSecretFile / mask", () => {
  test("isSecretFile detects .env variants but not .env.example", () => {
    expect(EnvFile.isSecretFile(".env")).toBe(true)
    expect(EnvFile.isSecretFile(".env.local")).toBe(true)
    expect(EnvFile.isSecretFile("sub/dir/.env.production")).toBe(true)
    expect(EnvFile.isSecretFile(".env.example")).toBe(false)
    expect(EnvFile.isSecretFile("env.ts")).toBe(false)
  })

  test("mask hides values but keeps key names, comments and blanks", () => {
    const masked = EnvFile.mask("# comment\n\nexport API_KEY=super-secret\nOTHER=value123\nnot a key line\n")
    expect(masked).not.toContain("super-secret")
    expect(masked).toContain("# comment")
    expect(masked).toContain("API_KEY=••••••••")
    expect(masked).toContain("not a key line")
  })
})

describe("EnvFile", () => {
  test("reads back exactly what set() wrote, quoting included", async () => {
    const file = await envFile()
    await EnvFile.set(file, { PLAIN: "abc123", TRICKY: 'a b "c" \\d', EMPTY: "" })
    expect(await EnvFile.value(file, "PLAIN")).toBe("abc123")
    expect(await EnvFile.value(file, "TRICKY")).toBe('a b "c" \\d')
    expect(await EnvFile.value(file, "EMPTY")).toBe("")
  })

  test("reads hand-written export and single quoted forms", async () => {
    const file = await envFile()
    await writeFile(file, "export QUOTED='hello world'\nBARE = spaced-out\n")
    expect(await EnvFile.value(file, "QUOTED")).toBe("hello world")
    expect(await EnvFile.value(file, "BARE")).toBe("spaced-out")
  })

  test("set creates .env with mode 0600 and merges in place", async () => {
    const file = await envFile()
    await writeFile(file, "# keep\nA=1\nB=2\n")
    await EnvFile.set(file, { B: "two", C: "3" })
    expect(await readFile(file, "utf8")).toBe("# keep\nA=1\nB=two\nC=3\n")
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  test("payload lists names, times and empty keys but never values", async () => {
    const file = await envFile()
    await EnvFile.set(file, { SECRET: "s3cr3t-value", BLANK: "" })
    const payload = await EnvFile.payload(file)
    expect(payload.keys).toEqual(["SECRET", "BLANK"])
    expect(payload.empty).toEqual(["BLANK"])
    expect(JSON.stringify(payload)).not.toContain("s3cr3t-value")
  })

  test("remove drops only the target key, including export form", async () => {
    const file = await envFile()
    await writeFile(file, "export A=1\nB=2\n")
    expect(await EnvFile.remove(file, "A")).toEqual(["B"])
    expect(await readFile(file, "utf8")).toBe("B=2\n")
  })
})
