import { Config } from "../config/config"
import z from "zod"
import { Provider } from "../provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { Instance } from "../project/instance"
import { Truncate } from "../tool/truncate"
import { ATTACHMENT_GLOB } from "../session/attachment-dir"
import { Auth } from "../auth"
import { ProviderTransform } from "../provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SIDE from "./prompt/side.txt"
import { SIDE_AGENT } from "../tool/handoff"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import { Permission } from "@/permission"
import { Wildcard } from "@/util/wildcard"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@/global"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { Effect, ServiceMap, Layer } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"

export namespace Agent {
  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      mode: z.enum(["subagent", "primary", "all"]),
      native: z.boolean().optional(),
      hidden: z.boolean().optional(),
      topP: z.number().optional(),
      temperature: z.number().optional(),
      color: z.string().optional(),
      permission: Permission.Ruleset,
      model: z
        .object({
          modelID: ModelID.zod,
          providerID: ProviderID.zod,
        })
        .optional(),
      variant: z.string().optional(),
      prompt: z.string().optional(),
      options: z.record(z.string(), z.any()),
      steps: z.number().int().positive().optional(),
    })
    .meta({
      ref: "Agent",
    })
  export type Info = z.infer<typeof Info>

  // 사이드 채팅(메인 세션을 포크한 개인용 대화) 전용. 메인 에이전트가 같은 워크트리에서 일하는 중에도
  // 돌기 때문에 읽기만 한다 — bash 는 읽기 전용으로 묶을 방법이 없어 통째로 막는다. "ask" 규칙을 두지
  // 않아서 권한 요청 독이 뜰 일이 없다. 포크한 세션의 permission 에도 그대로 넣어(세션 규칙이 마지막에
  // 적용된다) 에이전트를 바꿔 불러도 풀리지 않게 한다.
  export const SIDE = SIDE_AGENT
  /** 사이드 에이전트가 쓰는 도구. 나머지는 전부 막힌다. */
  const SIDE_TOOLS = ["read", "grep", "glob", "codesearch", "webfetch", "websearch", "handoff", "external_directory"]

  // 모듈 로드 시점이 아니라 호출 시점에 만든다 — Truncate 와 순환 import 가 생겨도 undefined 를 읽지 않게.
  export function sidePermission(): Permission.Ruleset {
    return Permission.fromConfig({
      "*": "deny",
      read: "allow",
      grep: "allow",
      glob: "allow",
      codesearch: "allow",
      webfetch: "allow",
      websearch: "allow",
      handoff: "allow",
      external_directory: {
        "*": "deny",
        [Truncate.GLOB]: "allow",
        [ATTACHMENT_GLOB]: "allow",
      },
    })
  }

  /**
   * 설정의 제한 중 사이드가 쓰는 도구에 걸리는 것만 남긴 규칙. 사이드 규칙 뒤에 붙여, 배포가 막은 읽기
   * 경로·네트워크 도구는 사이드에서도 막히게 한다.
   * - allow 는 버린다 — 사이드의 쓰기 금지를 풀면 안 된다.
   * - ask 는 deny 로 — 사이드는 권한 요청 독을 띄우지 않으므로 묻는 대신 막는다.
   * - 사이드가 이미 통째로 막은 도구의 규칙은 버린다. 경로별 규칙(edit "migration/*" 등)이 마지막에 오면
   *   그 도구가 "통째로 막힘"으로 보이지 않아 도구 목록에 다시 나타난다(Permission.disabled).
   */
  export function restrictive(ruleset: Permission.Ruleset): Permission.Ruleset {
    return ruleset.flatMap((rule) => {
      if (rule.action === "allow") return []
      if (!SIDE_TOOLS.some((tool) => Wildcard.match(tool, rule.permission))) return []
      return [{ ...rule, action: "deny" as const }]
    })
  }

  export interface Interface {
    readonly get: (agent: string) => Effect.Effect<Agent.Info>
    readonly list: () => Effect.Effect<Agent.Info[]>
    readonly defaultAgent: () => Effect.Effect<string>
    readonly generate: (input: {
      description: string
      model?: { providerID: ProviderID; modelID: ModelID }
    }) => Effect.Effect<{
      identifier: string
      whenToUse: string
      systemPrompt: string
    }>
  }

  type State = Omit<Interface, "generate">

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Agent") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const auth = yield* Auth.Service
      const skill = yield* Skill.Service

      const state = yield* InstanceState.make<State>(
        Effect.fn("Agent.state")(function* (ctx) {
          const cfg = yield* config.get()
          const skillDirs = yield* skill.dirs()
          const whitelistedDirs = [Truncate.GLOB, ATTACHMENT_GLOB, ...skillDirs.map((dir) => path.join(dir, "*"))]

          const defaults = Permission.fromConfig({
            "*": "allow",
            doom_loop: "ask",
            external_directory: {
              "*": "ask",
              ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
            },
            question: "deny",
            plan_enter: "deny",
            plan_exit: "deny",
            // 사이드 채팅 → 메인 입력창 전달 툴. side 에이전트만 쓴다.
            handoff: "deny",
            // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
            read: {
              "*": "allow",
              "*.env": "ask",
              "*.env.*": "ask",
              "*.env.example": "allow",
            },
          })

          const user = Permission.fromConfig(cfg.permission ?? {})

          const agents: Record<string, Info> = {
            build: {
              name: "build",
              description: "The default agent. Executes tools based on configured permissions.",
              options: {},
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  question: "allow",
                  plan_enter: "allow",
                }),
                user,
              ),
              mode: "primary",
              native: true,
            },
            plan: {
              name: "plan",
              description: "Plan mode. Disallows all edit tools.",
              options: {},
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  question: "allow",
                  plan_exit: "allow",
                  external_directory: {
                    [path.join(Global.Path.data, "plans", "*")]: "allow",
                  },
                  edit: {
                    "*": "deny",
                    [path.join(".opencode", "plans", "*.md")]: "allow",
                    [path.relative(Instance.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]:
                      "allow",
                  },
                }),
                user,
              ),
              mode: "primary",
              native: true,
            },
            general: {
              name: "general",
              description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  todowrite: "deny",
                }),
                user,
              ),
              options: {},
              mode: "subagent",
              native: true,
            },
            explore: {
              name: "explore",
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  "*": "deny",
                  grep: "allow",
                  glob: "allow",
                  list: "allow",
                  bash: "allow",
                  webfetch: "allow",
                  websearch: "allow",
                  codesearch: "allow",
                  read: "allow",
                  external_directory: {
                    "*": "ask",
                    ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
                  },
                }),
                user,
              ),
              description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
              prompt: PROMPT_EXPLORE,
              options: {},
              mode: "subagent",
              native: true,
            },
            [SIDE]: {
              name: SIDE,
              description: "Side chat. Answers questions about the forked conversation using read-only tools.",
              mode: "primary",
              native: true,
              hidden: true,
              prompt: PROMPT_SIDE,
              // 사이드 규칙은 사용자 설정의 allow 보다 뒤에 둔다 — 전역 "bash": "allow" 같은 설정이 읽기 전용을
              // 풀면 안 된다. 사용자 설정의 deny·ask 는 그 뒤에 다시 붙여, 배포가 막은 것은 사이드에서도 막힌다.
              permission: Permission.merge(defaults, user, sidePermission(), restrictive(user)),
              options: {},
            },
            compaction: {
              name: "compaction",
              mode: "primary",
              native: true,
              hidden: true,
              prompt: PROMPT_COMPACTION,
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  "*": "deny",
                }),
                user,
              ),
              options: {},
            },
            title: {
              name: "title",
              mode: "primary",
              options: {},
              native: true,
              hidden: true,
              temperature: 0.5,
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  "*": "deny",
                }),
                user,
              ),
              prompt: PROMPT_TITLE,
            },
            summary: {
              name: "summary",
              mode: "primary",
              options: {},
              native: true,
              hidden: true,
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  "*": "deny",
                }),
                user,
              ),
              prompt: PROMPT_SUMMARY,
            },
          }

          for (const [key, value] of Object.entries(cfg.agent ?? {})) {
            if (value.disable) {
              delete agents[key]
              continue
            }
            let item = agents[key]
            if (!item)
              item = agents[key] = {
                name: key,
                mode: "all",
                permission: Permission.merge(defaults, user),
                options: {},
                native: false,
              }
            if (value.model) item.model = Provider.parseModel(value.model)
            item.variant = value.variant ?? item.variant
            item.prompt = value.prompt ?? item.prompt
            item.description = value.description ?? item.description
            item.temperature = value.temperature ?? item.temperature
            item.topP = value.top_p ?? item.topP
            item.mode = value.mode ?? item.mode
            item.color = value.color ?? item.color
            item.hidden = value.hidden ?? item.hidden
            item.name = value.name ?? item.name
            item.steps = value.steps ?? item.steps
            item.options = mergeDeep(item.options, value.options ?? {})
            item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
          }

          // Ensure the globs below are allowed unless explicitly configured
          for (const glob of [Truncate.GLOB, ATTACHMENT_GLOB]) {
            for (const name in agents) {
              const agent = agents[name]
              const explicit = agent.permission.some((r) => {
                if (r.permission !== "external_directory") return false
                if (r.action !== "deny") return false
                return r.pattern === glob
              })
              if (explicit) continue

              agents[name].permission = Permission.merge(
                agents[name].permission,
                Permission.fromConfig({ external_directory: { [glob]: "allow" } }),
              )
            }
          }

          const get = Effect.fnUntraced(function* (agent: string) {
            return agents[agent]
          })

          const list = Effect.fnUntraced(function* () {
            const cfg = yield* config.get()
            return pipe(
              agents,
              values(),
              sortBy(
                [(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "build"), "desc"],
                [(x) => x.name, "asc"],
              ),
            )
          })

          const defaultAgent = Effect.fnUntraced(function* () {
            const c = yield* config.get()
            if (c.default_agent) {
              const agent = agents[c.default_agent]
              if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
              if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
              if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
              return agent.name
            }
            const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
            if (!visible) throw new Error("no primary visible agent found")
            return visible.name
          })

          return {
            get,
            list,
            defaultAgent,
          } satisfies State
        }),
      )

      return Service.of({
        get: Effect.fn("Agent.get")(function* (agent: string) {
          return yield* InstanceState.useEffect(state, (s) => s.get(agent))
        }),
        list: Effect.fn("Agent.list")(function* () {
          return yield* InstanceState.useEffect(state, (s) => s.list())
        }),
        defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
          return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
        }),
        generate: Effect.fn("Agent.generate")(function* (input: {
          description: string
          model?: { providerID: ProviderID; modelID: ModelID }
        }) {
          const cfg = yield* config.get()
          const model = input.model ?? (yield* Effect.promise(() => Provider.defaultModel()))
          const resolved = yield* Effect.promise(() => Provider.getModel(model.providerID, model.modelID))
          const language = yield* Effect.promise(() => Provider.getLanguage(resolved))

          const system = [PROMPT_GENERATE]
          yield* Effect.promise(() =>
            Plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system }),
          )
          const existing = yield* InstanceState.useEffect(state, (s) => s.list())

          const params = {
            experimental_telemetry: {
              isEnabled: cfg.experimental?.openTelemetry,
              metadata: {
                userId: cfg.username ?? "unknown",
              },
            },
            temperature: 0.3,
            messages: [
              ...system.map(
                (item): ModelMessage => ({
                  role: "system",
                  content: item,
                }),
              ),
              {
                role: "user",
                content: `Create an agent configuration based on this request: \"${input.description}\".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
              },
            ],
            model: language,
            schema: z.object({
              identifier: z.string(),
              whenToUse: z.string(),
              systemPrompt: z.string(),
            }),
          } satisfies Parameters<typeof generateObject>[0]

          // TODO: clean this up so provider specific logic doesnt bleed over
          const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
          if (model.providerID === "openai" && authInfo?.type === "oauth") {
            return yield* Effect.promise(async () => {
              const result = streamObject({
                ...params,
                providerOptions: ProviderTransform.providerOptions(resolved, {
                  store: false,
                }),
                onError: () => {},
              })
              for await (const part of result.fullStream) {
                if (part.type === "error") throw part.error
              }
              return result.object
            })
          }

          return yield* Effect.promise(() => generateObject(params).then((r) => r.object))
        }),
      })
    }),
  )

  export const defaultLayer = layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Skill.defaultLayer),
  )

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function get(agent: string) {
    return runPromise((svc) => svc.get(agent))
  }

  export async function list() {
    return runPromise((svc) => svc.list())
  }

  export async function defaultAgent() {
    return runPromise((svc) => svc.defaultAgent())
  }

  export async function generate(input: { description: string; model?: { providerID: ProviderID; modelID: ModelID } }) {
    return runPromise((svc) => svc.generate(input))
  }
}
