import { test, expect, describe } from "bun:test"
import fs from "fs"
import path from "path"
import { Assets } from "../../src/file/assets"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

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

describe("Assets.root", () => {
  test("sits in the session directory", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        expect(Assets.root()).toBe(path.join(Instance.directory, Assets.DIR))
      },
    })
  })

  test("follows the session into a subdirectory, where the file tree can actually show it", async () => {
    // At the worktree root instead, a session opened here could upload but never see or delete the
    // result: File.list only ever lists Instance.directory.
    await using tmp = await tmpdir({ git: true })
    const sub = path.join(tmp.path, "packages", "lib")
    fs.mkdirSync(sub, { recursive: true })
    await Instance.provide({
      directory: sub,
      fn: () => {
        expect(Assets.root()).toBe(path.join(sub, Assets.DIR))
      },
    })
  })

  test("does not depend on the worktree, which a non-git project reports as the filesystem root", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        expect(Instance.worktree).toBe("/")
        expect(Assets.root()).toBe(path.join(tmp.path, Assets.DIR))
      },
    })
  })
})

describe("Assets.resolve", () => {
  test("lands inside the assets folder", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        expect(Assets.resolve("a.txt")).toBe(path.join(Assets.root(), "a.txt"))
        expect(Assets.resolve("docs/a.txt")).toBe(path.join(Assets.root(), "docs", "a.txt"))
      },
    })
  })

  test("refuses to escape", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        expect(Assets.resolve("../escape.txt")).toBeUndefined()
        expect(Assets.resolve("../../../../etc/passwd")).toBeUndefined()
        expect(Assets.resolve("")).toBeUndefined()
        // An absolute path is treated as a set of segments, never as a destination.
        const out = Assets.resolve("/etc/passwd")
        expect(out).toBe(path.join(Assets.root(), "etc", "passwd"))
      },
    })
  })
})

describe("Assets.unique", () => {
  test("does not overwrite an existing upload", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        const root = Assets.root()
        fs.mkdirSync(root, { recursive: true })
        const target = path.join(root, "a.txt")
        expect(Assets.unique(target)).toBe(target)

        fs.writeFileSync(target, "one")
        expect(Assets.unique(target)).toBe(path.join(root, "a (2).txt"))

        fs.writeFileSync(path.join(root, "a (2).txt"), "two")
        expect(Assets.unique(target)).toBe(path.join(root, "a (3).txt"))
      },
    })
  })
})

describe("Assets.prepare", () => {
  test("creates the parent chain", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        const target = path.join(Assets.root(), "docs", "spec", "a.md")
        expect(Assets.prepare(target)).toBe(true)
        expect(fs.existsSync(path.dirname(target))).toBe(true)
      },
    })
  })

  test("refuses a subfolder symlinked out of the assets folder", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        const root = Assets.root()
        fs.mkdirSync(root, { recursive: true })
        const outside = path.join(tmp.path, "outside")
        fs.mkdirSync(outside, { recursive: true })
        // Someone (or something) plants a link where the next upload will write.
        fs.symlinkSync(outside, path.join(root, "docs"))

        // resolve() is satisfied: the path string is inside the folder.
        const target = Assets.resolve("docs/a.txt")!
        expect(target).toBe(path.join(root, "docs", "a.txt"))
        // prepare() is what actually catches it.
        expect(Assets.prepare(target)).toBe(false)
      },
    })
  })
})

describe("Assets.exclude", () => {
  test("adds the folder to .git/info/exclude once", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        const file = path.join(Instance.worktree, ".git", "info", "exclude")
        Assets.exclude()
        Assets.exclude()
        const lines = fs
          .readFileSync(file, "utf8")
          .split("\n")
          .filter((line) => line.trim() === Assets.DIR + "/")
        expect(lines.length).toBe(1)
      },
    })
  })

  test("covers an upload folder in a subdirectory, not just the worktree root", async () => {
    // The folder now follows the session directory, so one exclude line has to cover every one of
    // them. A pattern with no leading slash matches at any depth, which is what makes that true.
    await using tmp = await tmpdir({ git: true })
    const sub = path.join(tmp.path, "packages", "lib")
    fs.mkdirSync(sub, { recursive: true })

    await Instance.provide({
      directory: sub,
      fn: () => {
        Assets.exclude()
        fs.mkdirSync(Assets.root(), { recursive: true })
        fs.writeFileSync(path.join(Assets.root(), "a.txt"), "x")
      },
    })

    const status = await Bun.$`git status --short`.cwd(tmp.path).quiet().text()
    expect(status).not.toContain(Assets.DIR)
  })

  test("writes to the shared git dir from a linked worktree", async () => {
    // In a linked worktree ".git" is a file, and git only honors info/exclude from the shared
    // common dir — writing to <worktree>/.git/info/exclude does nothing at all.
    await using tmp = await tmpdir({ git: true })
    const linked = path.join(tmp.path, "..", `wt-${path.basename(tmp.path)}`)
    await Bun.$`git worktree add ${linked} -b assets-test`.cwd(tmp.path).quiet()

    try {
      await Instance.provide({
        directory: linked,
        fn: () => {
          expect(fs.statSync(path.join(Instance.worktree, ".git")).isFile()).toBe(true)
          Assets.exclude()

          const shared = fs.readFileSync(path.join(tmp.path, ".git", "info", "exclude"), "utf8")
          expect(shared).toContain(Assets.DIR + "/")
        },
      })

      // The real check: git in the linked worktree actually ignores the folder.
      fs.mkdirSync(path.join(linked, Assets.DIR), { recursive: true })
      fs.writeFileSync(path.join(linked, Assets.DIR, "a.txt"), "x")
      const status = await Bun.$`git status --short`.cwd(linked).quiet().text()
      expect(status).not.toContain(Assets.DIR)
    } finally {
      await Bun.$`git worktree remove --force ${linked}`.cwd(tmp.path).quiet().nothrow()
    }
  })

  test("leaves the project gitignore alone", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        const gitignore = path.join(Instance.worktree, ".gitignore")
        const before = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8") : null
        Assets.exclude()
        const after = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8") : null
        expect(after).toBe(before)
      },
    })
  })
})
