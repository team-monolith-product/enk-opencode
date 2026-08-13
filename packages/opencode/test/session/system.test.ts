import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Assets } from "../../src/file/assets"
import { Instance } from "../../src/project/instance"
import { SystemPrompt } from "../../src/session/system"
import { tmpdir } from "../fixture/fixture"

// environment() only reads the id fields off the model.
const MODEL = { api: { id: "claude-test" }, providerID: "anthropic" } as any

describe("session.system", () => {
  test("skills output is sorted by name and stable across calls", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        for (const [name, description] of [
          ["zeta-skill", "Zeta skill."],
          ["alpha-skill", "Alpha skill."],
          ["middle-skill", "Middle skill."],
        ]) {
          const skillDir = path.join(dir, ".opencode", "skill", name)
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: ${name}
description: ${description}
---

# ${name}
`,
          )
        }
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const build = await Agent.get("build")
          const first = await SystemPrompt.skills(build!)
          const second = await SystemPrompt.skills(build!)

          expect(first).toBe(second)

          const alpha = first!.indexOf("<name>alpha-skill</name>")
          const middle = first!.indexOf("<name>middle-skill</name>")
          const zeta = first!.indexOf("<name>zeta-skill</name>")

          expect(alpha).toBeGreaterThan(-1)
          expect(middle).toBeGreaterThan(alpha)
          expect(zeta).toBeGreaterThan(middle)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("environment says nothing about uploads when nothing was uploaded", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const [out] = await SystemPrompt.environment(MODEL)
        expect(out).not.toContain("<uploads>")
      },
    })
  })

  test("environment lists uploads and warns that search skips the folder", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = Assets.root()
        fs.mkdirSync(path.join(root, "docs"), { recursive: true })
        fs.writeFileSync(path.join(root, "설계안.pdf"), "x".repeat(2048))
        fs.writeFileSync(path.join(root, "docs", "api.md"), "y")

        const [out] = await SystemPrompt.environment(MODEL)
        expect(out).toContain("<uploads>")
        expect(out).toContain(root)
        expect(out).toContain("설계안.pdf (2 KB)")
        expect(out).toContain("docs/api.md (1 B)")
        expect(out).toContain("excluded from git")
      },
    })
  })

  test("environment tells the agent not to touch the originals or ship a path into them", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        fs.mkdirSync(Assets.root(), { recursive: true })
        fs.writeFileSync(path.join(Assets.root(), "logo.png"), "x")

        const [out] = await SystemPrompt.environment(MODEL)
        // The originals are the one thing in the workspace nothing can restore.
        expect(out).toContain("do not modify, delete or rename them")
        // Shipping a path into an uncommitted folder is a failure the running app never shows.
        expect(out).toContain("Nothing that ships may point here")
        expect(out).toContain("move it into the project's normal location")
      },
    })
  })
})
