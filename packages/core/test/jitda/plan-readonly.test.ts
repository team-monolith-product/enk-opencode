import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer, Schema } from "effect"
import { parse } from "jsonc-parser"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ConfigNormalize } from "@opencode/core/config/normalize"
import { ConfigAgentPlugin } from "@opencode/core/config/plugin/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Permission } from "@opencode/core/permission"
import { AgentPlugin } from "@opencode/core/plugin/agent"
import { PlanPlugin } from "@opencode/core/plugin/plan"
import { Document, Info } from "@opencode/schema/config"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Wildcard } from "@opencode/core/util/wildcard"
import { testEffect } from "../lib/effect"
import { agentHost, host } from "../plugin/host"

const layer = AppNodeBuilder.build(LayerNode.group([Agent.node, Bus.node, FSUtil.node, Global.node]))
const it = testEffect(layer)
const DOCKER_CONFIG = path.resolve(import.meta.dir, "../../../../docker/opencode.jsonc")
const home = "/home/jitda"
const decode = Schema.decodeUnknownSync(Info)

function normalize(input: unknown) {
  const result = ConfigNormalize.normalize(input)
  if (result.type !== "normalized") throw new Error("expected normalized config")
  return decode(result.encoded)
}

const stub = { dispose: Effect.void }

// pod 에 실리는 설정의 권한 부분만 옮겨 와 내장 에이전트·Plan 플러그인 위에 얹고, Plan 이 실제로 읽기 전용인지 본다.
const load = (withAgents = true) =>
  Effect.gen(function* () {
    const config = parse(yield* Effect.promise(() => Bun.file(DOCKER_CONFIG).text()))
    const agents = yield* Agent.Service
    const ctx = host({
      agent: agentHost(agents),
      tool: {
        transform: () => Effect.die("unused tool.transform"),
        reload: () => Effect.die("unused tool.reload"),
        list: () => Effect.die("unused tool.list"),
        hook: () => Effect.succeed(stub),
      },
      session: { hook: () => Effect.succeed(stub) },
    })
    yield* AgentPlugin.Plugin.effect(ctx)
    yield* PlanPlugin.Plugin.effect(ctx)
    const document = new Document({
      type: "document",
      info: normalize({ permission: config.permission, agent: withAgents ? config.agent : undefined }),
    })
    yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
      Effect.provide(Config.testLayer([document])),
    )
    const permissions = Effect.fnUntraced(function* (name: string) {
      const agent = yield* agents.get(Agent.ID.make(name))
      if (!agent) throw new Error(`expected ${name} agent`)
      return agent.permissions
    })
    return permissions
  }).pipe(Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home })))

// 도구 목록에서 빠지는지(Tool.snapshot 의 whollyDisabled 와 같은 판정).
const disabled = (action: string, rules: Permission.Ruleset) => {
  const rule = rules.findLast((item) => Wildcard.match(action, item.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

describe("plan agent in the pod config", () => {
  it.effect("cannot change the product before build", () =>
    Effect.gen(function* () {
      const plan = yield* (yield* load())("plan")
      const effect = (action: string, resource: string) => Permission.evaluate(action, resource, plan).effect

      expect(effect("edit", "src/App.tsx")).toBe("deny")
      expect(effect("edit", "index.html")).toBe("deny")
      expect(effect("edit", ".opencode/plans/plan.md")).toBe("allow")
      expect(effect("edit", path.join(home, ".opencode", "plan", "plan.md"))).toBe("allow")
      expect(effect("shell", "rm -rf src")).toBe("deny")
      expect(effect("subagent", "general")).toBe("deny")
      expect(effect("subagent", "explore")).toBe("deny")
      expect(effect("read", "src/App.tsx")).toBe("allow")

      for (const tool of [
        "shell",
        "subagent",
        "generate_image",
        "ensure_dev_server",
        "env_request",
        "playwright_browser_click",
        "playwright_browser_navigate",
      ])
        expect(disabled(tool, plan)).toBe(true)
      for (const tool of ["read", "edit", "grep", "glob", "question"]) expect(disabled(tool, plan)).toBe(false)
    }),
  )

  it.effect("needs the agent rules because the top-level allow wins over the built-in plan", () =>
    Effect.gen(function* () {
      const plan = yield* (yield* load(false))("plan")
      expect(Permission.evaluate("edit", "src/App.tsx", plan).effect).toBe("allow")
    }),
  )

  it.effect("leaves build free to work", () =>
    Effect.gen(function* () {
      const build = yield* (yield* load())("build")
      expect(Permission.evaluate("edit", "src/App.tsx", build).effect).toBe("allow")
      expect(Permission.evaluate("shell", "npm run dev", build).effect).toBe("allow")
    }),
  )

  it.effect("leaves the other agents exactly as the pod had them", () =>
    Effect.gen(function* () {
      const names = ["build", "explore", "general"]
      const snapshot = (withAgents: boolean) =>
        Effect.gen(function* () {
          return yield* Effect.forEach(names, yield* load(withAgents))
        }).pipe(Effect.provide(Layer.fresh(layer)))
      const configured = yield* snapshot(true)
      expect(configured.every((rules) => rules.length > 0)).toBe(true)
      expect(configured).toEqual(yield* snapshot(false))
    }),
  )
})
