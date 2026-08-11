import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ServeTargets } from "../../src/enk/serve-targets"

const ORIGINAL_ENV = {
  ENK_PROJECT_DIRECTORY: process.env["ENK_PROJECT_DIRECTORY"],
  JUPYTERHUB_USER: process.env["JUPYTERHUB_USER"],
  OPENCODE_SERVE_DOMAIN: process.env["OPENCODE_SERVE_DOMAIN"],
}
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  while (cleanups.length) await cleanups.pop()!()
})

// teams/{id}/{project,tutorial}-directory 형태의 워크스페이스를 만든다.
async function tempWorkspace(): Promise<{ project: string; tutorial: string }> {
  const root = await mkdtemp(join(tmpdir(), "serve-targets-"))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const project = join(root, "project-directory")
  const tutorial = join(root, "tutorial-directory")
  await mkdir(project, { recursive: true })
  await mkdir(tutorial, { recursive: true })
  return { project, tutorial }
}

describe("ServeTargets", () => {
  test("env 미설정이면 타깃이 없다", () => {
    delete process.env["ENK_PROJECT_DIRECTORY"]
    expect(ServeTargets.project()).toBeUndefined()
    expect(ServeTargets.tutorial()).toBeUndefined()
  })

  test("본행사는 :3000, 튜토리얼은 형제 폴더의 :3001", async () => {
    const { project, tutorial } = await tempWorkspace()
    process.env["ENK_PROJECT_DIRECTORY"] = project

    expect(ServeTargets.project()).toEqual({ kind: "project", dir: project, port: 3000 })
    expect(ServeTargets.tutorial()).toEqual({ kind: "tutorial", dir: tutorial, port: 3001 })
  })

  describe("previewHost", () => {
    // CSP frame-src 가 이 값으로 만들어진다 — 튜토리얼 호스트가 빠지면 미리보기 iframe 이
    // "이 콘텐츠는 차단되어 있습니다" 로 통째로 막힌다.
    test("본행사는 {user}, 튜토리얼은 {user}-tutorial 서브도메인", () => {
      process.env["JUPYTERHUB_USER"] = "team-42"
      process.env["OPENCODE_SERVE_DOMAIN"] = "dev.jitda.io"

      expect(ServeTargets.previewHost("project")).toBe("https://team-42.dev.jitda.io")
      expect(ServeTargets.previewHost("tutorial")).toBe("https://team-42-tutorial.dev.jitda.io")
    })

    test("스포너 env 가 없으면 undefined", () => {
      delete process.env["JUPYTERHUB_USER"]
      process.env["OPENCODE_SERVE_DOMAIN"] = "dev.jitda.io"

      expect(ServeTargets.previewHost("project")).toBeUndefined()
      expect(ServeTargets.previewHost("tutorial")).toBeUndefined()
    })
  })

  describe("forCwd", () => {
    test("본행사 하위 경로는 project 타깃", async () => {
      const { project } = await tempWorkspace()
      process.env["ENK_PROJECT_DIRECTORY"] = project

      expect(ServeTargets.forCwd(join(project, "src", "app"))?.kind).toBe("project")
    })

    test("튜토리얼 하위 경로는 tutorial 타깃 (디렉토리 미존재여도 경로로 판정)", async () => {
      const { project, tutorial } = await tempWorkspace()
      process.env["ENK_PROJECT_DIRECTORY"] = project

      const target = ServeTargets.forCwd(join(tutorial, "gone", "src"))
      expect(target?.kind).toBe("tutorial")
      expect(target?.port).toBe(3001)
      expect(target?.dir).toBe(tutorial)
    })

    test("env 미설정이어도 tutorial-directory 세그먼트로 식별", () => {
      delete process.env["ENK_PROJECT_DIRECTORY"]

      const target = ServeTargets.forCwd("/efs/profiles/p1/tutorial-directory/sub")
      expect(target?.kind).toBe("tutorial")
      expect(target?.dir).toBe("/efs/profiles/p1/tutorial-directory")
    })

    test("규약 밖 경로는 undefined", () => {
      delete process.env["ENK_PROJECT_DIRECTORY"]

      expect(ServeTargets.forCwd("/somewhere/else")).toBeUndefined()
    })
  })
})
