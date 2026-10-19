import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProjectSummary } from "../src/project-summary"

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})

describe("ProjectSummary", () => {
  test("parses the first JSON object even inside fences or after thinking", () => {
    expect(
      ProjectSummary.parse(
        '<think>hm</think>\n```json\n{"title":"할 일 앱","description":"할 일을 관리합니다.","usage":"할 일을 입력합니다"}\n```',
      ),
    ).toEqual({ title: "할 일 앱", description: "할 일을 관리합니다.", usage: "할 일을 입력합니다" })
    expect(ProjectSummary.parse("no json")).toBeUndefined()
  })

  test("collects text files, skips secrets, dependencies and binaries, and ranks entry files first", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jitda-summary-"))
    dirs.push(root)
    await mkdir(path.join(root, "node_modules", "x"), { recursive: true })
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "node_modules", "x", "a.js"), "x")
    await writeFile(path.join(root, ".env"), "KEY=secret")
    await writeFile(path.join(root, "logo.png"), "png")
    await writeFile(path.join(root, "src", "util.ts"), "export {}")
    await writeFile(path.join(root, "index.html"), "<h1>앱</h1>")
    expect((await ProjectSummary.collectFiles(root)).sort()).toEqual(["index.html", "src/util.ts"])
    expect(ProjectSummary.rankFiles(["src/util.ts", "index.html"], "")).toEqual(["index.html", "src/util.ts"])
    const context = await ProjectSummary.workspaceContext(root, "")
    expect(context).toContain("=== index.html ===")
    expect(context).not.toContain("secret")
  })

  test("builds the transcript from user and assistant text only", () => {
    expect(
      ProjectSummary.transcript([
        { type: "user", text: "할 일 앱 만들어줘" },
        { type: "assistant", content: [{ type: "tool" }, { type: "text", text: "만들었어요" }] },
        { type: "synthetic", text: "x" },
      ]),
    ).toBe("[user] 할 일 앱 만들어줘\n\n[assistant] 만들었어요")
  })
})
