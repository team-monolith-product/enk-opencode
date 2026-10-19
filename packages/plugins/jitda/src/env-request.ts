import type { Plugin } from "@opencode/plugin"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { EnvFile } from "./env-file"
import DESCRIPTION from "./env-request.txt"

// AI 가 앱에 필요한 외부 서비스 값을 참가자에게 요청한다. 값은 이 모듈 밖으로 나가지 않는다.
//   AI → env_request   이름·표시명만 넘긴다(값 필드가 아예 없다)
//   UI → submit(value) 값을 받아 그 자리에서 .env 로 쓰고 버린다
//   AI ← status        saved / skipped / canceled 만 돌려받는다
// 이벤트·응답·로그 어디에도 값을 싣지 않는다.

type Context = Plugin.Context

export type Status = "saved" | "skipped" | "canceled"

export type Info = { name: string; label: string; reason?: string; docsUrl?: string; replace?: boolean }

export type Request = Info & {
  id: string
  sessionID: string
  tool?: { messageID: string; callID: string }
}

type Pending = { info: Request; resolve: (result: { status: Status; name: string }) => void }

export const INPUT = {
  type: "object",
  properties: {
    name: {
      type: "string",
      pattern: EnvFile.KEY_REGEX.source,
      maxLength: 256,
      description: "Environment variable name the app reads (UPPER_SNAKE_CASE)",
    },
    label: { type: "string", maxLength: 120, description: "Service name shown to the user, in their language" },
    reason: { type: "string", maxLength: 500, description: "Why this value is needed, in the user's language" },
    docsUrl: { type: "string", maxLength: 500, description: "Where the user can obtain the value" },
    replace: {
      type: "boolean",
      description:
        "Hint that the user is replacing an existing value. Optional — the tool opens the input even when a value is already stored",
    },
  },
  required: ["name", "label"],
  additionalProperties: false,
} as const

const VALID_VALUE = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= 8192 && !/[\r\n]/.test(value)

const VALID_NAME = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 256 && EnvFile.KEY_REGEX.test(value)

export function createRequests(file: () => string) {
  const pending = new Map<string, Pending>()
  const listeners = new Set<
    (event: { type: "asked"; request: Request } | { type: "resolved"; data: unknown }) => void
  >()
  const emit = (event: Parameters<typeof listeners extends Set<infer F> ? F : never>[0]) => {
    for (const listener of listeners) listener(event)
  }

  const resolve = (id: string, status: Status) => {
    const entry = pending.get(id)
    if (!entry) return false
    pending.delete(id)
    emit({
      type: "resolved",
      data: { sessionID: entry.info.sessionID, requestID: id, name: entry.info.name, status },
    })
    entry.resolve({ status, name: entry.info.name })
    return true
  }

  return {
    on: (listener: typeof listeners extends Set<infer F> ? F : never) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    list: () => Array.from(pending.values(), (entry) => entry.info),
    ask(input: { sessionID: string; info: Info; tool?: Request["tool"]; signal?: AbortSignal }) {
      const id = `envreq_${randomUUID()}`
      const info: Request = {
        ...input.info,
        id,
        sessionID: input.sessionID,
        ...(input.tool ? { tool: input.tool } : {}),
      }
      return new Promise<{ status: Status; name: string }>((done) => {
        pending.set(id, { info, resolve: done })
        emit({ type: "asked", request: info })
        input.signal?.addEventListener("abort", () => resolve(id, "canceled"), { once: true })
      })
    },
    // 쓰기가 실패하면 요청을 열어 둔 채 던진다. 저장하지 못한 것을 저장됨으로 알리지 않는다.
    async submit(input: { requestID: string; value: unknown; name?: unknown }) {
      const entry = pending.get(input.requestID)
      if (!entry) return false
      if (!VALID_VALUE(input.value)) throw new Error("value must be 1-8192 characters without newlines")
      if (input.name !== undefined && !VALID_NAME(input.name)) throw new Error("invalid name")
      if (input.name) entry.info.name = input.name
      await EnvFile.set(file(), { [entry.info.name]: input.value })
      return resolve(input.requestID, "saved")
    },
    skip: (requestID: string) => resolve(requestID, "skipped"),
    reject: (requestID: string) => resolve(requestID, "canceled"),
    cancelAll() {
      for (const id of [...pending.keys()]) resolve(id, "canceled")
    },
  }
}

const OUTPUT = {
  saved: (name: string) =>
    `The user stored a value for ${name}. Continue with the work. The value stays hidden from you — write code that reads ${name} from the environment.`,
  skipped: (name: string) =>
    `The user chose to continue without ${name}. Use sample or placeholder data and say clearly in your reply that the data is temporary.`,
  canceled: (name: string) => `The user dismissed the request for ${name}. Do not re-open it unless they bring it up.`,
}

const object = { type: "object", additionalProperties: true } as const

export const RequestRpc = {
  id: "jitda.env-request",
  methods: {
    list: { input: { type: "object", additionalProperties: false }, output: object },
    submit: {
      input: {
        type: "object",
        properties: { requestID: { type: "string" }, value: { type: "string" }, name: { type: "string" } },
        required: ["requestID", "value"],
        additionalProperties: false,
      },
      output: object,
    },
    skip: {
      input: {
        type: "object",
        properties: { requestID: { type: "string" } },
        required: ["requestID"],
        additionalProperties: false,
      },
      output: object,
    },
    reject: {
      input: {
        type: "object",
        properties: { requestID: { type: "string" } },
        required: ["requestID"],
        additionalProperties: false,
      },
      output: object,
    },
  },
  events: {
    asked: { schema: object },
    resolved: { schema: object },
  },
} as const

export const FileRpc = {
  id: "jitda.env-file",
  methods: {
    list: { input: { type: "object", additionalProperties: false }, output: object },
    value: {
      input: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
      output: object,
    },
    set: {
      input: {
        type: "object",
        properties: { values: { type: "object", additionalProperties: { type: "string" } } },
        required: ["values"],
        additionalProperties: false,
      },
      output: object,
    },
    remove: {
      input: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
      output: object,
    },
  },
  events: {},
} as const

export const EnvRpc = {
  id: "jitda.env",
  methods: { get: { input: { type: "object", additionalProperties: false }, output: object } },
  events: {},
} as const

export function clientEnv(env: NodeJS.ProcessEnv = process.env) {
  return {
    ...(env.OPENCODE_SERVE_DOMAIN ? { serveDomain: env.OPENCODE_SERVE_DOMAIN } : {}),
    ...(env.JUPYTERHUB_USER ? { jupyterhubUser: env.JUPYTERHUB_USER } : {}),
    ...(env.ENVIRONMENT ? { environment: env.ENVIRONMENT } : {}),
    ...(env.ENK_AI_MODEL ? { aiModel: env.ENK_AI_MODEL } : {}),
    ...(env.ENK_AI_MODEL_VARIANT ? { aiModelVariant: env.ENK_AI_MODEL_VARIANT } : {}),
  }
}

function validValues(values: unknown): Record<string, string> {
  if (typeof values !== "object" || values === null) throw new Error("values must be an object")
  const entries = Object.entries(values)
  if (entries.length === 0) throw new Error("values must not be empty")
  for (const [name, value] of entries) {
    if (!VALID_NAME(name)) throw new Error(`invalid name: ${name}`)
    if (typeof value !== "string" || value.length > 8192 || /[\r\n]/.test(value))
      throw new Error(`invalid value for ${name}`)
  }
  return values as Record<string, string>
}

export async function start(ctx: Context) {
  const file = () => path.join(ctx.location.directory, ".env")
  const requests = createRequests(file)

  const requestRpc = await ctx.rpc.register(RequestRpc, {
    list: async () => ({ requests: requests.list() }),
    submit: async (raw) => {
      const input = raw as { requestID: string; value: string; name?: string }
      return { ok: await requests.submit(input) }
    },
    skip: async (raw) => ({ ok: requests.skip((raw as { requestID: string }).requestID) }),
    reject: async (raw) => ({ ok: requests.reject((raw as { requestID: string }).requestID) }),
  })
  const stop = requests.on((event) => {
    if (event.type === "asked") void requestRpc.events.emit("asked", event.request)
    else void requestRpc.events.emit("resolved", event.data as Record<string, unknown>)
  })

  const fileRpc = await ctx.rpc.register(FileRpc, {
    list: async () => EnvFile.payload(file()),
    value: async (raw) => {
      const name = (raw as { name: unknown }).name
      if (!VALID_NAME(name)) throw new Error("invalid name")
      const value = await EnvFile.value(file(), name)
      if (value === undefined) throw new Error(`${name} is not stored`)
      return { name, value }
    },
    set: async (raw) => {
      await EnvFile.set(file(), validValues((raw as { values: unknown }).values))
      return EnvFile.payload(file())
    },
    remove: async (raw) => {
      const name = (raw as { name: unknown }).name
      if (!VALID_NAME(name)) throw new Error("invalid name")
      await EnvFile.remove(file(), name)
      return EnvFile.payload(file())
    },
  })

  const envRpc = await ctx.rpc.register(EnvRpc, { get: async () => clientEnv() })

  const tools = await ctx.tool.transform((editor) => {
    editor.add({
      name: "env_request",
      description: DESCRIPTION,
      input: INPUT,
      options: { codemode: false },
      execute: async (raw, call) => {
        const input = raw as Info
        const existing = await EnvFile.names(file())
        const replace = !!input.replace || existing.includes(input.name)
        const result = await requests.ask({
          sessionID: call.sessionID,
          info: { ...input, ...(replace ? { replace } : {}) },
          tool: { messageID: call.messageID, callID: call.id },
          signal: call.signal,
        })
        return { content: OUTPUT[result.status](result.name), metadata: { name: result.name, status: result.status } }
      },
    })
  })

  return async () => {
    requests.cancelAll()
    stop()
    await tools.dispose()
    await requestRpc.dispose()
    await fileRpc.dispose()
    await envRpc.dispose()
  }
}

export * as EnvRequest from "./env-request"
