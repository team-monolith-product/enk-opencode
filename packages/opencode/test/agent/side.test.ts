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
