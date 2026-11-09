import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { parse } from "jsonc-parser"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { Permission } from "../../src/permission"
import { tmpdir } from "../fixture/fixture"

const DOCKER_CONFIG = path.resolve(import.meta.dir, "../../../../docker/opencode.jsonc")

afterEach(async () => {
  await Instance.disposeAll()
})

// pod 에 실리는 설정의 권한 부분만 옮겨 와 Plan 이 실제로 읽기 전용인지 본다.
async function podPermissions(withAgents = true) {
  const config = parse(await Bun.file(DOCKER_CONFIG).text())
  return tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({ permission: config.permission, agent: withAgents ? config.agent : undefined }),
      )
    },
  })
}

async function permissions(withAgents: boolean, name: string) {
  await using tmp = await podPermissions(withAgents)
  return Instance.provide({ directory: tmp.path, fn: async () => (await Agent.get(name)).permission })
}

describe("plan agent in the pod config", () => {
  test("cannot change the product before build", async () => {
    await using tmp = await podPermissions()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const plan = await Agent.get("plan")
        const action = (permission: string, pattern: string) =>
          Permission.evaluate(permission, pattern, plan.permission).action

        expect(action("edit", "src/App.tsx")).toBe("deny")
        expect(action("edit", "index.html")).toBe("deny")
        expect(action("edit", ".opencode/plans/plan.md")).toBe("allow")
        expect(action("bash", "rm -rf src")).toBe("deny")
        // 브라우저 도구도 bash 명령이라 같이 막힌다(미리보기 앱을 직접 조작하지 못하게)
        expect(action("bash", "browser-check http://localhost:3000")).toBe("deny")
        expect(action("bash", 'agent-browser batch "open http://localhost:3000"')).toBe("deny")
        expect(action("task", "general")).toBe("deny")
        expect(action("task", "explore")).toBe("deny")
        expect(action("read", "src/App.tsx")).toBe("allow")

        const tools = [
          "edit",
          "write",
          "apply_patch",
          "bash",
          "generate_image",
          "ensure_dev_server",
          "env_request",
          "task",
          "read",
        ]
        const disabled = Permission.disabled(tools, plan.permission)
        for (const tool of ["bash", "generate_image", "ensure_dev_server", "env_request", "task"])
          expect(disabled.has(tool)).toBe(true)
        expect(disabled.has("read")).toBe(false)
      },
    })
  })

  test("leaves build free to work", async () => {
    await using tmp = await podPermissions()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await Agent.get("build")
        expect(Permission.evaluate("edit", "src/App.tsx", build.permission).action).toBe("allow")
        expect(Permission.evaluate("bash", "npm run dev", build.permission).action).toBe("allow")
      },
    })
  })

  test("build keeps the debugging browser commands but not the ones that change or leave the pod", async () => {
    await using tmp = await podPermissions()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await Agent.get("build")
        const bash = (command: string) => Permission.evaluate("bash", command, build.permission).action
        for (const command of [
          "browser-check http://localhost:3000",
          "browser-check -s http://localhost:3000 3000",
          'agent-browser batch --json "open http://localhost:3000" "errors" "close"',
          "agent-browser doctor",
        ])
          expect(bash(command)).toBe("allow")
        for (const command of [
          "agent-browser install",
          "agent-browser install --with-deps",
          "agent-browser upgrade",
          "agent-browser chat hello",
          "agent-browser connect 9222",
          "agent-browser plugin add x",
          "agent-browser dashboard start",
          "agent-browser stream enable",
        ])
          expect(bash(command)).toBe("deny")
        // bash 도구 자체는 꺼지지 않는다(하위 명령만 막힘)
        expect(Permission.disabled(["bash"], build.permission).has("bash")).toBe(false)
        // 최상위를 문자열에서 객체로 바꿨어도 나머지는 예전처럼 다 허용
        expect(Permission.evaluate("edit", "src/App.tsx", build.permission).action).toBe("allow")
        expect(Permission.evaluate("webfetch", "*", build.permission).action).toBe("allow")
      },
    })
  })

  test("leaves the other agents exactly as the pod had them", async () => {
    for (const name of ["build", "explore", "general"]) {
      expect(await permissions(true, name)).toEqual(await permissions(false, name))
    }
  })
})
