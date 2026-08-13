import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Ripgrep } from "../../src/file/ripgrep"

describe("file.ripgrep", () => {
  test("defaults to include hidden", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "visible.txt"), "hello")
        await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
        await Bun.write(path.join(dir, ".opencode", "thing.json"), "{}")
      },
    })

    const files = await Array.fromAsync(Ripgrep.files({ cwd: tmp.path }))
    const hasVisible = files.includes("visible.txt")
    const hasHidden = files.includes(path.join(".opencode", "thing.json"))
    expect(hasVisible).toBe(true)
    expect(hasHidden).toBe(true)
  })

  test("hidden false excludes hidden", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "visible.txt"), "hello")
        await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
        await Bun.write(path.join(dir, ".opencode", "thing.json"), "{}")
      },
    })

    const files = await Array.fromAsync(Ripgrep.files({ cwd: tmp.path, hidden: false }))
    const hasVisible = files.includes("visible.txt")
    const hasHidden = files.includes(path.join(".opencode", "thing.json"))
    expect(hasVisible).toBe(true)
    expect(hasHidden).toBe(false)
  })

  test("search returns empty when nothing matches", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "match.ts"), "const value = 'other'\n")
      },
    })

    const hits = await Ripgrep.search({
      cwd: tmp.path,
      pattern: "needle",
    })

    expect(hits).toEqual([])
  })
})

describe("file.ripgrep noIgnore", () => {
  // The upload folder is listed in git's info/exclude so it stays out of diffs. That also hides it
  // from ripgrep, which is why the agent's search tools opt out when pointed at it.
  const excluded = async (dir: string) => {
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true })
    await Bun.write(path.join(dir, ".git", "info", "exclude"), "__assets__/\n")
    await fs.mkdir(path.join(dir, "__assets__"), { recursive: true })
    await Bun.write(path.join(dir, "__assets__", "notes.txt"), "needle in the uploads")
  }

  test("files skips a git-excluded folder by default", async () => {
    await using tmp = await tmpdir({ git: true, init: excluded })
    const files = await Array.fromAsync(Ripgrep.files({ cwd: tmp.path }))
    expect(files.some((file) => file.includes("__assets__"))).toBe(false)
  })

  test("files reaches it with noIgnore", async () => {
    await using tmp = await tmpdir({ git: true, init: excluded })
    const files = await Array.fromAsync(Ripgrep.files({ cwd: tmp.path, noIgnore: true }))
    expect(files.some((file) => file.includes("__assets__"))).toBe(true)
  })

  test("search reaches it with noIgnore", async () => {
    await using tmp = await tmpdir({ git: true, init: excluded })
    expect(await Ripgrep.search({ cwd: tmp.path, pattern: "needle" })).toEqual([])
    const found = await Ripgrep.search({ cwd: tmp.path, pattern: "needle", noIgnore: true })
    expect(found.length).toBeGreaterThan(0)
  })
})
