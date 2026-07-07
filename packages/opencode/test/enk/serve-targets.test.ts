import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ServeTargets } from "../../src/enk/serve-targets"

const ORIGINAL_ENV = process.env["ENK_PROJECT_DIRECTORY"]
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  if (ORIGINAL_ENV === undefined) delete process.env["ENK_PROJECT_DIRECTORY"]
  else process.env["ENK_PROJECT_DIRECTORY"] = ORIGINAL_ENV
  while (cleanups.length) await cleanups.pop()!()
})

// teams/{id}/{project,tutorial}-directory 형태의 워크스페이스를 만든다.
async function tempWorkspace(withTutorial: boolean): Promise<{ project: string; tutorial: string }> {
  const root = await mkdtemp(join(tmpdir(), "serve-targets-"))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const project = join(root, "project-directory")
  const tutorial = join(root, "tutorial-directory")
  await mkdir(project, { recursive: true })
  if (withTutorial) await mkdir(tutorial, { recursive: true })
  return { project, tutorial }
}

describe("ServeTargets.all", () => {
  test("env 미설정이면 빈 목록", () => {
    delete process.env["ENK_PROJECT_DIRECTORY"]
    expect(ServeTargets.all()).toEqual([])
  })

  test("튜토리얼 디렉토리가 없으면 project 만", async () => {
    const { project } = await tempWorkspace(false)
    process.env["ENK_PROJECT_DIRECTORY"] = project
    const targets = ServeTargets.all()
    expect(targets.map((t) => t.kind)).toEqual(["project"])
    expect(targets[0].port).toBe(3000)
  })

  test("둘 다 있으면 project(3000) + tutorial(3001)", async () => {
    const { project, tutorial } = await tempWorkspace(true)
    process.env["ENK_PROJECT_DIRECTORY"] = project
    const targets = ServeTargets.all()
    expect(targets.map((t) => [t.kind, t.port])).toEqual([
      ["project", 3000],
      ["tutorial", 3001],
    ])
    expect(targets[1].dir).toBe(tutorial)
  })
})

describe("ServeTargets.forCwd", () => {
  test("project 하위 경로는 project 타깃", async () => {
    const { project } = await tempWorkspace(true)
    process.env["ENK_PROJECT_DIRECTORY"] = project
    expect(ServeTargets.forCwd(join(project, "src", "app"))?.kind).toBe("project")
  })

  test("tutorial 하위 경로는 tutorial 타깃 (디렉토리 미존재여도 경로로 판정)", async () => {
    const { project, tutorial } = await tempWorkspace(false)
    process.env["ENK_PROJECT_DIRECTORY"] = project
    const target = ServeTargets.forCwd(join(tutorial, "src"))
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
