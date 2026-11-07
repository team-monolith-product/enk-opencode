import { afterEach, expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { Permission } from "../../src/permission"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

const TOOLS = [
  "bash",
  "edit",
  "write",
  "apply_patch",
  "task",
  "todowrite",
  "question",
  "env_request",
  "read",
  "grep",
  "glob",
  "webfetch",
  "handoff",
]

test("side agent is hidden and limited to read tools plus handoff", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const side = await Agent.get(Agent.SIDE)
      expect(side.hidden).toBe(true)
      expect(side.mode).toBe("primary")
      const enabled = TOOLS.filter((tool) => !Permission.disabled([tool], side.permission).has(tool))
      expect(enabled.sort()).toEqual(["glob", "grep", "handoff", "read", "webfetch"])
    },
  })
})

test("side agent stays read-only when the user allows everything globally", async () => {
  await using tmp = await tmpdir({ config: { permission: { bash: "allow", edit: "allow", "*": "allow" } } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const side = await Agent.get(Agent.SIDE)
      expect(Permission.evaluate("bash", "*", side.permission).action).toBe("deny")
      expect(Permission.evaluate("edit", "*", side.permission).action).toBe("deny")
    },
  })
})

test("side agent never asks, so no permission dock is needed", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const side = await Agent.get(Agent.SIDE)
      for (const tool of TOOLS) expect(Permission.evaluate(tool, "*", side.permission).action).not.toBe("ask")
      expect(Permission.evaluate("external_directory", "/etc/passwd", side.permission).action).toBe("deny")
    },
  })
})

test("handoff is denied for every other agent", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      for (const agent of await Agent.list()) {
        if (agent.name === Agent.SIDE) continue
        expect(Permission.disabled(["handoff"], agent.permission).has("handoff")).toBe(true)
      }
    },
  })
})

test("side agent is never picked as the default agent", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(await Agent.defaultAgent()).not.toBe(Agent.SIDE)
    },
  })
})

// 배포 설정이 막은 읽기 경로·네트워크 도구를 사이드가 다시 열면 안 된다(세션 규칙으로도).
test("side agent keeps configured denials and turns asks into denials", async () => {
  await using tmp = await tmpdir({
    config: { permission: { read: { "secret/*": "deny" }, webfetch: "deny", websearch: "ask" } } as never,
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const side = await Agent.get(Agent.SIDE)
      expect(Permission.evaluate("read", "secret/key.txt", side.permission).action).toBe("deny")
      expect(Permission.evaluate("read", "src/app.ts", side.permission).action).toBe("allow")
      expect(Permission.disabled(["webfetch", "websearch"], side.permission)).toEqual(
        new Set(["webfetch", "websearch"]),
      )
      expect(Permission.evaluate("bash", "*", side.permission).action).toBe("deny")
    },
  })
})

// 사이드가 이미 막은 도구에 대한 경로별 설정 규칙이 뒤에 붙어도, 그 도구는 계속 목록에서 빠져 있어야 한다.
test("path-scoped config rules for blocked tools do not re-expose them", async () => {
  await using tmp = await tmpdir({ config: { permission: { edit: { "migration/*": "deny" }, bash: "ask" } } as never })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const side = await Agent.get(Agent.SIDE)
      expect(Permission.disabled(["edit", "bash", "read"], side.permission)).toEqual(new Set(["edit", "bash"]))
    },
  })
})

// 설정의 허용 예외(전체 deny 안의 src/* allow)도 메인과 같게 지켜야 한다.
test("side agent keeps configured allow exceptions for its own tools", async () => {
  await using tmp = await tmpdir({ config: { permission: { read: { "*": "deny", "src/*": "allow" } } } as never })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const side = await Agent.get(Agent.SIDE)
      const build = await Agent.get("build")
      for (const file of ["src/app.ts", "secret/key.txt"])
        expect(Permission.evaluate("read", file, side.permission).action).toBe(
          Permission.evaluate("read", file, build.permission).action,
        )
      expect(Permission.evaluate("read", "src/app.ts", side.permission).action).toBe("allow")
    },
  })
})

test("a wildcard allow in config does not reopen write tools", async () => {
  await using tmp = await tmpdir({ config: { permission: "allow" } as never })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const side = await Agent.get(Agent.SIDE)
      expect(Permission.disabled(["bash", "edit", "task", "read"], side.permission)).toEqual(
        new Set(["bash", "edit", "task"]),
      )
    },
  })
})
