import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Assets } from "../src/assets"

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})
async function project() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jitda-assets-"))
  dirs.push(dir)
  return dir
}
async function* chunks(...parts: string[]) {
  for (const part of parts) yield new TextEncoder().encode(part)
}

describe("Assets.segment", () => {
  test("keeps ordinary names untouched", () => {
    expect(Assets.segment("report.pdf")).toBe("report.pdf")
    expect(Assets.segment("my-file_v2 (final).csv")).toBe("my-file_v2 (final).csv")
  })

  test("keeps non-ascii names, which are the whole point of not using basename+strip", () => {
    expect(Assets.segment("설계안.pdf")).toBe("설계안.pdf")
    expect(Assets.segment("日本語 メモ.txt")).toBe("日本語 メモ.txt")
  })

  test("replaces separators, control characters and windows-illegal characters", () => {
    expect(Assets.segment("a/b.txt")).toBe("a_b.txt")
    expect(Assets.segment("a\\b.txt")).toBe("a_b.txt")
    expect(Assets.segment("a\0b.txt")).toBe("a_b.txt")
    expect(Assets.segment("a\nb.txt")).toBe("a_b.txt")
    expect(Assets.segment('a:*?"<>|b.txt')).toBe("a_______b.txt")
  })

  test("strips leading dots so uploads cannot hide from the tree", () => {
    expect(Assets.segment(".env")).toBe("env")
    expect(Assets.segment("...gitconfig")).toBe("gitconfig")
  })

  test("strips trailing dots and spaces that windows would drop silently", () => {
    expect(Assets.segment("report.pdf.")).toBe("report.pdf")
    expect(Assets.segment("report.pdf   ")).toBe("report.pdf")
  })

  test("rejects a segment with nothing left", () => {
    expect(Assets.segment("")).toBeUndefined()
    expect(Assets.segment("...")).toBeUndefined()
    expect(Assets.segment("   ")).toBeUndefined()
  })

  test("defuses windows reserved device names", () => {
    expect(Assets.segment("CON")).toBe("_CON")
    expect(Assets.segment("nul.txt")).toBe("_nul.txt")
    expect(Assets.segment("COM1")).toBe("_COM1")
    expect(Assets.segment("console.log")).toBe("console.log")
  })

  test("truncates the stem but preserves the extension", () => {
    const long = "a".repeat(400) + ".pdf"
    const out = Assets.segment(long)!
    expect(out.length).toBeLessThanOrEqual(100)
    expect(out.endsWith(".pdf")).toBe(true)
  })
})

describe("Assets.relative", () => {
  test("keeps nested directory uploads", () => {
    expect(Assets.relative("docs/spec/api.md")).toBe("docs/spec/api.md")
    expect(Assets.relative("docs\\spec\\api.md")).toBe("docs/spec/api.md")
  })

  test("collapses shape noise", () => {
    expect(Assets.relative("/docs//api.md")).toBe("docs/api.md")
    expect(Assets.relative("./docs/api.md")).toBe("docs/api.md")
  })

  test("rejects .. outright rather than sanitizing it away", () => {
    expect(Assets.relative("../escape.txt")).toBeUndefined()
    expect(Assets.relative("docs/../../escape.txt")).toBeUndefined()
    expect(Assets.relative("..")).toBeUndefined()
  })

  test("rejects paths past the depth cap", () => {
    const deep = Array.from({ length: Assets.MAX_DEPTH + 1 }, (_, i) => `d${i}`).join("/") + "/f.txt"
    expect(Assets.relative(deep)).toBeUndefined()
  })

  test("rejects an empty path", () => {
    expect(Assets.relative("")).toBeUndefined()
    expect(Assets.relative("/")).toBeUndefined()
  })
})

describe("Assets upload", () => {
  test("stores bytes verbatim under the folder and never overwrites", async () => {
    const dir = await project()
    expect(await Assets.upload(dir, "spec/설계안.pdf", 5, chunks("ab", "cde"))).toMatchObject({
      path: "spec/설계안.pdf",
      size: 5,
    })
    expect((await Assets.upload(dir, "spec/설계안.pdf", 1, chunks("z"))).path).toBe("spec/설계안 (2).pdf")
    expect(await readFile(path.join(dir, "__assets__", "spec", "설계안.pdf"), "utf8")).toBe("abcde")
    expect(Assets.snapshot(dir).usage).toEqual({ count: 2, bytes: 6 })
  })

  test("refuses to escape the folder, including through a symlinked subfolder", async () => {
    const dir = await project()
    await expect(Assets.upload(dir, "../outside.txt", 1, chunks("x"))).rejects.toThrow("Invalid upload path")
    const outside = await project()
    await mkdir(path.join(dir, "__assets__"), { recursive: true })
    await symlink(outside, path.join(dir, "__assets__", "link"))
    await expect(Assets.upload(dir, "link/x.txt", 1, chunks("x"))).rejects.toThrow("Invalid upload path")
  })

  test("removes a partial file when the body is over the per-file cap", async () => {
    const dir = await project()
    async function* huge() {
      yield new Uint8Array(Assets.MAX_FILE_BYTES)
      yield new Uint8Array(1)
    }
    await expect(Assets.upload(dir, "big.bin", 0, huge())).rejects.toThrow("too large")
    expect(Assets.list(dir)).toEqual([])
  })

  test("adds the folder to git's info/exclude once", async () => {
    const dir = await project()
    await mkdir(path.join(dir, ".git", "info"), { recursive: true })
    await Assets.upload(dir, "a.txt", 1, chunks("a"))
    await Assets.upload(dir, "b.txt", 1, chunks("b"))
    expect(await readFile(path.join(dir, ".git", "info", "exclude"), "utf8")).toBe("__assets__/\n")
  })

  test("a claim is visible to the next one, so overlapping uploads cannot each take the last slot", async () => {
    const dir = await project()
    const first = Assets.claim(dir, Assets.MAX_TOTAL_BYTES - 10)
    expect(first).toEqual({ bytes: Assets.MAX_TOTAL_BYTES - 10 })
    expect(Assets.claim(dir, 20)).toBe("total")
  })

  test("deletes one file or the whole folder", async () => {
    const dir = await project()
    await Assets.upload(dir, "a.txt", 1, chunks("a"))
    await Assets.upload(dir, "b.txt", 1, chunks("b"))
    await Assets.remove(dir, "a.txt")
    expect(Assets.list(dir).map((entry) => entry.path)).toEqual(["b.txt"])
    await Assets.remove(dir)
    expect(Assets.list(dir)).toEqual([])
  })

  test("lists uploads for the system prompt and stays silent when there are none", async () => {
    const dir = await project()
    expect(Assets.prompt(dir)).toBe("")
    await writeFile(path.join(dir, "x"), "")
    await Assets.upload(dir, "data.csv", 3, chunks("a,b"))
    expect(Assets.prompt(dir)).toContain("  data.csv (3 B)")
  })
})
