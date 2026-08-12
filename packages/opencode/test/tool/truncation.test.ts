import { describe, test, expect } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, FileSystem, Layer } from "effect"
import { Truncate, Truncate as TruncateSvc } from "../../src/tool/truncate"
import { Identifier } from "../../src/id/id"
import { Process } from "../../src/util/process"
import { Filesystem } from "../../src/util/filesystem"
import path from "path"
import { utimes } from "fs/promises"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { writeFileStringScoped } from "../lib/filesystem"
import { Secret } from "../../src/util/secret"

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures")
const ROOT = path.resolve(import.meta.dir, "..", "..")

describe("Truncate", () => {
  describe("output", () => {
    test("truncates large json file by bytes", async () => {
      const content = await Filesystem.readText(path.join(FIXTURES_DIR, "models-api.json"))
      const result = await Truncate.output(content)

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("truncated...")
      if (result.truncated) expect(result.outputPath).toBeDefined()
    })

    // 잘린 원문은 파일로 남고 모델이 그 경로를 읽을 수 있다 — 거기에도 시크릿이 남으면 안 된다.
    test("removes project .env values from both the preview and the saved file", async () => {
      const secret = "sk-proj-truncation-9f2b1c7d"
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => Bun.write(path.join(dir, ".env"), `OPENAI_API_KEY=${secret}\n`),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Secret.reset()
          const lines = Array.from({ length: 100 }, (_, i) => `line${i} ${secret}`).join("\n")
          const result = await Truncate.output(lines, { maxLines: 10 })

          expect(result.truncated).toBe(true)
          expect(result.content).not.toContain(secret)
          expect(result.content).toContain("[redacted]")
          if (result.truncated) {
            const saved = await Filesystem.readText(result.outputPath)
            expect(saved).not.toContain(secret)
          }
        },
      })
      Secret.reset()
    })

    test("returns content unchanged when under limits", async () => {
      const content = "line1\nline2\nline3"
      const result = await Truncate.output(content)

      expect(result.truncated).toBe(false)
      expect(result.content).toBe(content)
    })

    test("truncates by line count", async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      const result = await Truncate.output(lines, { maxLines: 10 })

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("...90 lines truncated...")
    })

    test("truncates by byte count", async () => {
      const content = "a".repeat(1000)
      const result = await Truncate.output(content, { maxBytes: 100 })

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("truncated...")
    })

    test("truncates from head by default", async () => {
      const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
      const result = await Truncate.output(lines, { maxLines: 3 })

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("line0")
      expect(result.content).toContain("line1")
      expect(result.content).toContain("line2")
      expect(result.content).not.toContain("line9")
    })

    test("truncates from tail when direction is tail", async () => {
      const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
      const result = await Truncate.output(lines, { maxLines: 3, direction: "tail" })

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("line7")
      expect(result.content).toContain("line8")
      expect(result.content).toContain("line9")
      expect(result.content).not.toContain("line0")
    })

    test("uses default MAX_LINES and MAX_BYTES", () => {
      expect(Truncate.MAX_LINES).toBe(2000)
      expect(Truncate.MAX_BYTES).toBe(50 * 1024)
    })

    test("large single-line file truncates with byte message", async () => {
      const content = await Filesystem.readText(path.join(FIXTURES_DIR, "models-api.json"))
      const result = await Truncate.output(content)

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("bytes truncated...")
      expect(Buffer.byteLength(content, "utf-8")).toBeGreaterThan(Truncate.MAX_BYTES)
    })

    test("writes full output to file when truncated", async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      const result = await Truncate.output(lines, { maxLines: 10 })

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("The tool call succeeded but the output was truncated")
      expect(result.content).toContain("Grep")
      if (!result.truncated) throw new Error("expected truncated")
      expect(result.outputPath).toBeDefined()
      expect(result.outputPath).toContain("tool_")

      const written = await Filesystem.readText(result.outputPath!)
      expect(written).toBe(lines)
    })

    test("suggests Task tool when agent has task permission", async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      const agent = { permission: [{ permission: "task", pattern: "*", action: "allow" as const }] }
      const result = await Truncate.output(lines, { maxLines: 10 }, agent as any)

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("Grep")
      expect(result.content).toContain("Task tool")
    })

    test("omits Task tool hint when agent lacks task permission", async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      const agent = { permission: [{ permission: "task", pattern: "*", action: "deny" as const }] }
      const result = await Truncate.output(lines, { maxLines: 10 }, agent as any)

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("Grep")
      expect(result.content).not.toContain("Task tool")
    })

    test("does not write file when not truncated", async () => {
      const content = "short content"
      const result = await Truncate.output(content)

      expect(result.truncated).toBe(false)
      if (result.truncated) throw new Error("expected not truncated")
      expect("outputPath" in result).toBe(false)
    })

    test("loads truncate effect in a fresh process", async () => {
      const out = await Process.run([process.execPath, "run", path.join(ROOT, "src", "tool", "truncate.ts")], {
        cwd: ROOT,
      })

      expect(out.code).toBe(0)
    }, 20000)
  })

  describe("cleanup", () => {
    const DAY_MS = 24 * 60 * 60 * 1000
    const it = testEffect(Layer.mergeAll(TruncateSvc.defaultLayer, NodeFileSystem.layer))

    const touch = (file: string, at: number) =>
      Effect.promise(() => utimes(file, new Date(at), new Date(at)))

    it.effect("deletes files untouched for 7 days and preserves recently touched ones", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        yield* fs.makeDirectory(Truncate.DIR, { recursive: true })

        const stale = path.join(Truncate.DIR, Identifier.create("tool", false, Date.now() - 10 * DAY_MS))
        const recent = path.join(Truncate.DIR, Identifier.create("tool", false, Date.now() - 3 * DAY_MS))
        // Created long ago but read again since: retention follows last use, not creation, so an
        // output the model is still referencing does not expire out from under it.
        const revisited = path.join(Truncate.DIR, Identifier.create("tool", false, Date.now() - 11 * DAY_MS))

        yield* writeFileStringScoped(stale, "stale content")
        yield* writeFileStringScoped(recent, "recent content")
        yield* writeFileStringScoped(revisited, "revisited content")
        yield* touch(stale, Date.now() - 10 * DAY_MS)
        yield* touch(recent, Date.now() - 3 * DAY_MS)

        yield* TruncateSvc.Service.use((s) => s.cleanup())

        expect(yield* fs.exists(stale)).toBe(false)
        expect(yield* fs.exists(recent)).toBe(true)
        expect(yield* fs.exists(revisited)).toBe(true)
      }),
    )
  })
})

describe("Truncate.limits", () => {
  test("falls back to defaults without an instance context", async () => {
    const result = await Truncate.limits()
    expect(result).toEqual({ maxLines: Truncate.MAX_LINES, maxBytes: Truncate.MAX_BYTES })
  })

  test("honors tool_output overrides from config", async () => {
    await using tmp = await tmpdir({ config: { tool_output: { max_lines: 5, max_bytes: 40 } } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await Truncate.limits()).toEqual({ maxLines: 5, maxBytes: 40 })

        const result = await Truncate.output(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"))
        expect(result.truncated).toBe(true)
        expect(result.content).toContain("truncated...")
        expect(result.content).not.toContain("line 19")
      },
    })
  })
})
