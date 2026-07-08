import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DevServerReplay } from "../../src/enk/dev-server-replay"

const ORIGINAL_ENV = process.env["ENK_PROJECT_DIRECTORY"]
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  if (ORIGINAL_ENV === undefined) delete process.env["ENK_PROJECT_DIRECTORY"]
  else process.env["ENK_PROJECT_DIRECTORY"] = ORIGINAL_ENV
  while (cleanups.length) await cleanups.pop()!()
})

async function tempProjectDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dev-server-replay-"))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

// teams/{id}/{project,tutorial}-directory 형태의 워크스페이스를 만든다.
async function tempWorkspace(): Promise<{ project: string; tutorial: string }> {
  const root = await tempProjectDir()
  const project = join(root, "project-directory")
  const tutorial = join(root, "tutorial-directory")
  await mkdir(project, { recursive: true })
  await mkdir(tutorial, { recursive: true })
  return { project, tutorial }
}

async function writeState(dir: string, state: DevServerReplay.State) {
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(join(dir, ".opencode", "dev-server.json"), JSON.stringify(state))
}

describe("DevServerReplay", () => {
  describe("record", () => {
    test("writes the state file under .opencode in the fallback directory", async () => {
      const dir = await tempProjectDir()
      const state = { cmd: "npm run dev -- --port 3000", cwd: dir, port: 3000 }

      await DevServerReplay.record(state, dir)

      const raw = await readFile(join(dir, ".opencode", "dev-server.json"), "utf8")
      expect(JSON.parse(raw)).toEqual(state)
    })

    test("prefers ENK_PROJECT_DIRECTORY over the fallback so record and replay agree", async () => {
      const canonical = await tempProjectDir()
      const session = await tempProjectDir()
      const state = { cmd: "npm run dev -- --port 3000", cwd: session, port: 3000 }

      process.env["ENK_PROJECT_DIRECTORY"] = canonical
      await DevServerReplay.record(state, session)

      const raw = await readFile(join(canonical, ".opencode", "dev-server.json"), "utf8")
      expect(JSON.parse(raw)).toEqual(state)
      expect(existsSync(join(session, ".opencode", "dev-server.json"))).toBe(false)
    })

    test("writes a tutorial-cwd record into the tutorial directory", async () => {
      const { project, tutorial } = await tempWorkspace()
      await mkdir(join(tutorial, "src"), { recursive: true })
      const state = { cmd: "npm run dev -- --port 3001 --strictPort", cwd: join(tutorial, "src"), port: 3001 }

      process.env["ENK_PROJECT_DIRECTORY"] = project
      await DevServerReplay.record(state, project)

      const raw = await readFile(join(tutorial, ".opencode", "dev-server.json"), "utf8")
      expect(JSON.parse(raw)).toEqual(state)
      expect(existsSync(join(project, ".opencode", "dev-server.json"))).toBe(false)
    })
  })

  describe("loadRecord", () => {
    test("returns the record when cwd belongs to the target", async () => {
      const { project } = await tempWorkspace()
      const state = { cmd: "npm run dev", cwd: project, port: 3000 }
      await writeState(project, state)

      process.env["ENK_PROJECT_DIRECTORY"] = project
      const loaded = await DevServerReplay.loadRecord({ kind: "project", dir: project, port: 3000 })
      expect(loaded).toEqual(state)
    })

    test("returns undefined when the state file is missing", async () => {
      const { project } = await tempWorkspace()
      process.env["ENK_PROJECT_DIRECTORY"] = project
      expect(await DevServerReplay.loadRecord({ kind: "project", dir: project, port: 3000 })).toBeUndefined()
    })

    test("returns undefined for a record whose cwd belongs to another target", async () => {
      const { project, tutorial } = await tempWorkspace()
      // 규약 이전에 남은 기록 — 본행사 파일에 튜토리얼 cwd 가 들어 있다.
      await writeState(project, { cmd: "npm run dev", cwd: tutorial, port: 3000 })

      process.env["ENK_PROJECT_DIRECTORY"] = project
      expect(await DevServerReplay.loadRecord({ kind: "project", dir: project, port: 3000 })).toBeUndefined()
    })

    test("returns undefined when the recorded cwd no longer exists", async () => {
      const { project } = await tempWorkspace()
      await writeState(project, { cmd: "npm run dev", cwd: join(project, "gone"), port: 3000 })

      process.env["ENK_PROJECT_DIRECTORY"] = project
      expect(await DevServerReplay.loadRecord({ kind: "project", dir: project, port: 3000 })).toBeUndefined()
    })

    test("strips leading install steps from the recorded cmd", async () => {
      const { project } = await tempWorkspace()
      await writeState(project, {
        cmd: "npm install && npm run dev -- --host 0.0.0.0 --port 3000 --strictPort",
        cwd: project,
        port: 3000,
      })

      process.env["ENK_PROJECT_DIRECTORY"] = project
      const loaded = await DevServerReplay.loadRecord({ kind: "project", dir: project, port: 3000 })
      expect(loaded?.cmd).toBe("npm run dev -- --host 0.0.0.0 --port 3000 --strictPort")
    })

    test("returns undefined when the recorded cmd is install steps only", async () => {
      const { project } = await tempWorkspace()
      await writeState(project, { cmd: "npm ci && npm install", cwd: project, port: 3000 })

      process.env["ENK_PROJECT_DIRECTORY"] = project
      expect(await DevServerReplay.loadRecord({ kind: "project", dir: project, port: 3000 })).toBeUndefined()
    })
  })

  describe("stripInstallSteps", () => {
    test.each([
      ["npm install && npm run dev", "npm run dev"],
      ["npm ci --no-audit && node server.js", "node server.js"],
      ["pnpm i && pnpm dev", "pnpm dev"],
      ["yarn && yarn dev", "yarn dev"],
      ["bun install && bun run dev", "bun run dev"],
      ["npm run dev -- --port 3000", "npm run dev -- --port 3000"],
      ["yarn dev", "yarn dev"],
      ["npx --yes serve -l 3000 .", "npx --yes serve -l 3000 ."],
      ["npm install", ""],
    ])("%s -> %s", (input, expected) => {
      expect(DevServerReplay.stripInstallSteps(input)).toBe(expected)
    })
  })
})
