import { describe, expect, test } from "bun:test"
import { Glob } from "bun"

/**
 * `bun test` runs every file of this package in one process, and a module mock patches the module
 * registry for that whole process — it is never scoped to the file that registered it, and there is
 * no way to undo one. So the moment a suite stubs a module that some *other* suite exercises for
 * real, the other suite breaks. Whether it actually breaks depends on which file the runner reaches
 * first, and that order comes from the filesystem: it differed between macOS and CI's Linux box, so
 * the whole app suite was red on CI (15 failures) while passing on every developer's machine.
 *
 * The rule this guards: only mock a module that no other suite needs the real version of. When you
 * need to swap out something a real suite uses, pass it in instead — see PromptDocInput.createPage
 * in components/prompt-input/doc.ts.
 *
 * Adding a specifier below is fine, but check first that nothing else under src/ tests the real
 * module, and run the full `bun run test` — not just your own file.
 */
const ALLOWED = [
  "@/context/file",
  "@/context/global-sync",
  "@/context/language",
  "@/context/layout",
  "@/context/local",
  "@/context/permission",
  "@/context/platform",
  "@/context/prompt",
  "@/context/sdk",
  "@/context/sync",
  "@opencode-ai/ui/collapsible",
  "@opencode-ai/ui/context",
  "@opencode-ai/ui/file-icon",
  "@opencode-ai/ui/icon",
  "@opencode-ai/ui/toast",
  "@opencode-ai/ui/tooltip",
  "@opencode-ai/util/encode",
  "@solidjs/router",
]

const CALL = /mock\s*\.\s*module\(\s*["']([^"']+)["']/g

describe("module mocks", () => {
  test("only cover modules no other suite exercises for real", async () => {
    const root = new URL("./", import.meta.url).pathname
    const found = new Set<string>()
    for await (const file of new Glob("**/*.test.ts").scan(root)) {
      // This file names specifiers only to list them; scanning it would match its own allowlist.
      if (file === "module-mock-allowlist.test.ts") continue
      const source = await Bun.file(root + file).text()
      for (const match of source.matchAll(CALL)) found.add(match[1]!)
    }
    expect([...found].sort()).toEqual([...ALLOWED].sort())
  })
})
