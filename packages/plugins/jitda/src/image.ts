import type { Plugin } from "@opencode/plugin"
import { randomUUID } from "node:crypto"
import { mkdir, readdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import DESCRIPTION from "./generate-image.txt"
import type { Reporter } from "./ai-usage"
import { toolAttributes } from "./ai-usage"

type Context = Plugin.Context

export const MODEL = "gpt-image-1-mini"
// USD per 1M tokens — https://developers.openai.com/api/docs/pricing
const PRICE = { text: 2, image: 2.5, output: 8 }
const TIMEOUT_MS = 180_000
const QUOTA_TIMEOUT_MS = 15_000
const QUOTA_ROUTE = "/api/v1/opencode/image_generations"
const TOGGLE_KEY = "image-generation"
const DEFAULT_PHASE = "team"
export const FOLDER = "ai-images"

export const FORMATS = { png: "png", webp: "webp", jpg: "jpeg" } as const
export type Format = keyof typeof FORMATS

export type Usage = {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { text_tokens?: number; image_tokens?: number }
}

export type Status = "generated" | "off" | "subagent" | "blocked" | "timeout" | "limited" | "disabled" | "unavailable"

export type Quota = { limit: number; used: number; remaining: number; phase?: string }

export type State =
  | { kind: "unlimited" }
  | { kind: "unavailable" }
  | { kind: "disabled" }
  | { kind: "known"; quota: Quota }

export function cost(usage: Usage | undefined) {
  if (!usage) return 0
  const input = usage.input_tokens ?? 0
  const image = usage.input_tokens_details?.image_tokens ?? 0
  const text = usage.input_tokens_details?.text_tokens ?? input - image
  return (text * PRICE.text + image * PRICE.image + (usage.output_tokens ?? 0) * PRICE.output) / 1_000_000
}

// 파드에서는 CHP 가 OPENAI_BASE_URL 로 실키를 주입하고, 로컬에서는 OPENAI_API_KEY 로 직접 부른다.
export function endpoint(env: NodeJS.ProcessEnv = process.env) {
  const key = env.OPENAI_API_KEY
  const base = env.OPENAI_BASE_URL ?? (key ? "https://api.openai.com/v1" : undefined)
  if (!base) return undefined
  return { url: base.replace(/\/+$/, "") + "/images/generations", key: key ?? "proxy-auth" }
}

export function slug(name: string) {
  const base = path.basename(name).replace(/\.[^.]*$/, "")
  const cleaned = base
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
  return cleaned || "image"
}

const isDir = (target: string) =>
  stat(target).then(
    (value) => value.isDirectory(),
    () => false,
  )
const exists = (target: string) =>
  stat(target).then(
    () => true,
    () => false,
  )

// AI 가 만든 이미지는 결과물이 정적 파일을 서빙하는 폴더 아래 한 곳에 모으고, / 로 시작하는 경로를 돌려준다.
export async function servedRoot(directory: string) {
  if (await isDir(path.join(directory, "public"))) return { folder: path.join("public", FOLDER), url: `/${FOLDER}` }
  if (await isDir(path.join(directory, "static")))
    return { folder: path.join("static", FOLDER), url: `/static/${FOLDER}` }
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const nested: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue
    if (
      (await exists(path.join(directory, entry.name, "package.json"))) &&
      (await isDir(path.join(directory, entry.name, "public")))
    )
      nested.push(entry.name)
  }
  if (nested.length === 1) return { folder: path.join(nested[0]!, "public", FOLDER), url: `/${FOLDER}` }
  return { folder: FOLDER, url: `/${FOLDER}` }
}

const claimed = new Set<string>()

// 같은 이름으로 동시에 그려도 덮어쓰지 않게, 저장이 끝날 때까지 고른 경로를 잡아 둔다.
export async function location(directory: string, name: string, format: Format) {
  const root = await servedRoot(directory)
  const stem = slug(name)
  for (let n = 1; ; n++) {
    const file = `${n === 1 ? stem : `${stem}-${n}`}.${format}`
    const relative = path.join(root.folder, file)
    const absolute = path.join(directory, relative)
    if (claimed.has(absolute)) continue
    claimed.add(absolute)
    if (await exists(absolute)) {
      claimed.delete(absolute)
      continue
    }
    return { relative, absolute, url: `${root.url}/${file}`, release: () => claimed.delete(absolute) }
  }
}

export type Outcome =
  | { kind: "image"; bytes: Buffer; usage?: Usage }
  | { kind: "blocked"; reason?: string }
  | { kind: "timeout" }

// 학생이 응답을 멈춰도 끊지 않는다. 이미 청구된 그림을 버리지 않고 저장·과금·개수에 반영한다.
export async function request(input: {
  prompt: string
  size: string
  quality: string
  background: string
  format: (typeof FORMATS)[Format]
}): Promise<Outcome> {
  const api = endpoint()
  if (!api) throw new Error("이미지 생성이 설정되지 않은 환경입니다 (OPENAI_BASE_URL / OPENAI_API_KEY 없음).")
  const res = await fetch(api.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${api.key}` },
    body: JSON.stringify({
      model: MODEL,
      prompt: input.prompt,
      n: 1,
      size: input.size,
      quality: input.quality,
      background: input.background,
      output_format: input.format,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((error) => {
    if (error instanceof Error && error.name === "TimeoutError") return undefined
    throw error
  })
  if (!res) return { kind: "timeout" }
  const body = (await res.json().catch(() => undefined)) as
    | { data?: { b64_json?: string }[]; usage?: Usage; error?: { code?: string; message?: string } }
    | undefined
  if (!res.ok) {
    if (body?.error?.code === "moderation_blocked") return { kind: "blocked", reason: body.error.message }
    throw new Error(`이미지 생성 실패 (${res.status}): ${body?.error?.message ?? res.statusText}`)
  }
  const b64 = body?.data?.[0]?.b64_json
  if (!b64) throw new Error("이미지 생성 응답에 이미지가 없습니다.")
  return { kind: "image", bytes: Buffer.from(b64, "base64"), usage: body?.usage }
}

const REFUSAL =
  "다시 호출하지 말고, 학생에게 짧게 알린 뒤 CSS·SVG·이모지 등 이미지 파일 없이 표현하는 방법을 제안하세요."

export function output(status: Exclude<Status, "generated">, quota?: Quota) {
  return {
    subagent:
      "서브에이전트에서는 이미지를 그리지 않습니다. 여기서 만든 그림은 학생 채팅에 보이지 않기 때문입니다. 그림이 필요하면 결과에 그렇게 적어 메인 대화에서 그리게 하세요.",
    off: "학생이 이번 메시지에서 입력창의 '이미지 만들기'를 꺼 두어 그리지 않았습니다. 다시 호출하지 말고, 그림이 꼭 필요하면 '이미지 만들기'를 켜고 다시 요청해 달라고 짧게 안내하세요. 토글은 메시지마다 바뀌므로 켜진 메시지에서는 이 도구로 그릴 수 있습니다.",
    unavailable: `이 작업 공간에서는 이미지 생성을 쓸 수 없습니다. ${REFUSAL}`,
    disabled: `이 해커톤에서는 이미지 생성을 사용하지 않습니다. ${REFUSAL}`,
    limited: `이 팀이 만들 수 있는 이미지 ${quota?.limit}장을 모두 사용했습니다. 이번에는 그리지 말고, 학생에게 짧게 알린 뒤 CSS·SVG·이모지 등 이미지 파일 없이 표현하는 방법을 제안하세요. 운영자가 한도를 늘릴 수 있으니, 학생이 나중에 다시 그림을 요청하면 이 도구를 다시 호출해도 됩니다. 남은 개수가 없으면 도구가 바로 알려 줍니다.`,
    blocked:
      "안전 정책에 걸려 이미지를 만들지 못했습니다(이번 시도는 개수에서 빠집니다). 학생에게 짧게 알리고, 실존 인물·상표·폭력적 표현을 뺀 오리지널 디자인으로 프롬프트를 바꿔 제안하세요.",
    timeout:
      "이미지 생성이 너무 오래 걸려 그림을 받지 못했습니다. 생성 비용이 이미 나갔을 수 있어 이번 시도는 개수에 남습니다. 같은 그림을 바로 다시 요청하지 말고 학생에게 짧게 알리세요.",
  }[status]
}

// 팀당 한도는 rails 가 센다. 한도는 hub 가 spawn 때 주입한 값만 쓰고, 사용 개수는 예약·반납 응답으로 저장해 둔다.
// 튜토리얼과 본행사는 따로 세므로 rails 가 알려준 구간(phase)별로 저장한다. rails 에 닿지 못하면 생성하지 않는다.
export function createQuota(storage: Pick<Context["storage"], "get" | "set">, env: NodeJS.ProcessEnv = process.env) {
  const rails = () => {
    const url = env.ENK_HACKATHON_RAILS_URL
    const token = env.ENK_AI_USAGE_TOKEN
    if (!url || !token) return undefined
    return { url: url.replace(/\/+$/, "") + QUOTA_ROUTE, token }
  }
  const phase = () => env.ENK_IMAGE_GENERATION_PHASE || DEFAULT_PHASE
  const key = (value: string) => `image-quota/${value}`

  const save = async (quota: Quota) => {
    await storage.set(key(quota.phase ?? DEFAULT_PHASE), { limit: quota.limit, used: quota.used }).catch(() => {})
  }

  const parse = async (res: Response) => (await res.json().catch(() => undefined)) as Quota | undefined

  const state = async (): Promise<State> => {
    if (!rails()) return { kind: "unlimited" }
    const raw = env.ENK_IMAGE_GENERATION_LIMIT
    const limit = raw === undefined || raw === "" ? undefined : Number(raw)
    if (limit === undefined || !Number.isFinite(limit) || limit < 0) return { kind: "unavailable" }
    if (limit === 0) return { kind: "disabled" }
    const stored = (await storage.get(key(phase())).catch(() => undefined)) as { used?: number } | undefined
    const used = stored?.used ?? 0
    return { kind: "known", quota: { limit, used, remaining: Math.max(limit - used, 0) } }
  }

  const reserve = async (callID: string) => {
    const target = rails()
    if (!target) return { status: "reserved" as const, quota: undefined }
    const res = await fetch(target.url, {
      method: "POST",
      headers: { Authorization: `token ${target.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ call_id: callID }),
      signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS),
    }).catch(() => undefined)
    if (!res) throw new Error("이미지 생성 가능 개수를 확인하지 못했습니다. 잠시 후 다시 시도하세요.")
    if (res.status === 403) return { status: "unavailable" as const }
    const quota = await parse(res)
    if (quota) await save(quota)
    if (res.status === 409 && quota) return { status: "exhausted" as const, quota }
    if (!res.ok) throw new Error(`이미지 생성 가능 개수를 확인하지 못했습니다 (${res.status}).`)
    return { status: "reserved" as const, quota }
  }

  // 그림을 썼으면 확정(PATCH)하고 아니면 반납(DELETE)한다. 확정되지 않은 예약은 rails 가 일정 시간 뒤 뺀다.
  const settle = async (callID: string, method: "PATCH" | "DELETE") => {
    const target = rails()
    if (!target) return
    const res = await fetch(`${target.url}/${encodeURIComponent(callID)}`, {
      method,
      headers: { Authorization: `token ${target.token}` },
      signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS),
    }).catch(() => undefined)
    const quota = res?.ok ? await parse(res) : undefined
    if (quota) await save(quota)
  }

  return {
    state,
    async withReservation<T>(callID: string, run: (quota: Quota | undefined) => Promise<{ kept: boolean; value: T }>) {
      const reservation = await reserve(callID)
      if (reservation.status !== "reserved") return reservation
      const result = await run(reservation.quota).catch(async (error) => {
        await settle(callID, "DELETE")
        throw error
      })
      await settle(callID, result.kept ? "PATCH" : "DELETE")
      return { status: "reserved" as const, value: result.value }
    },
  }
}

export type QuotaService = ReturnType<typeof createQuota>

export const INPUT = {
  type: "object",
  properties: {
    prompt: { type: "string", minLength: 1, description: "그릴 내용을 구체적으로 묘사한 프롬프트" },
    name: {
      type: "string",
      description: "파일 이름. 내용을 알 수 있는 짧은 영문 이름 (예: hero-cat). 폴더는 도구가 정한다",
    },
    format: { type: "string", enum: ["png", "webp", "jpg"], default: "png" },
    size: { type: "string", enum: ["1024x1024", "1536x1024", "1024x1536"], default: "1024x1024" },
    quality: { type: "string", enum: ["low", "medium", "high"], default: "medium" },
    background: { type: "string", enum: ["auto", "transparent", "opaque"], default: "auto" },
  },
  required: ["prompt", "name"],
  additionalProperties: false,
} as const

type Input = {
  prompt: string
  name: string
  format?: Format
  size?: string
  quality?: string
  background?: string
}

export async function toggled(storage: Pick<Context["storage"], "get">) {
  const value = (await storage.get(TOGGLE_KEY).catch(() => undefined)) as { on?: boolean } | undefined
  return value?.on ?? true
}

export async function status(storage: Pick<Context["storage"], "get">, quota: QuotaService) {
  const on = await toggled(storage)
  if (!endpoint()) return { enabled: false, on }
  const state = await quota.state()
  if (state.kind === "known") return { enabled: true, on, quota: state.quota }
  return { enabled: state.kind === "unlimited", on }
}

export const Rpc = {
  id: "jitda.image",
  methods: {
    get: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object", additionalProperties: true },
    },
    toggle: {
      input: {
        type: "object",
        properties: { on: { type: "boolean" } },
        required: ["on"],
        additionalProperties: false,
      },
      output: { type: "object", additionalProperties: true },
    },
  },
  events: {
    updated: {
      schema: {
        type: "object",
        properties: { on: { type: "boolean" } },
        required: ["on"],
        additionalProperties: false,
      },
    },
  },
} as const

export async function start(ctx: Context, reporter: Reporter | undefined) {
  const quota = createQuota(ctx.storage)
  const registration = await ctx.rpc.register(Rpc, {
    get: async () => status(ctx.storage, quota),
    toggle: async (input) => {
      const on = (input as { on: boolean }).on
      await ctx.storage.set(TOGGLE_KEY, { on })
      await registration.events.emit("updated", { on })
      return status(ctx.storage, quota)
    },
  })

  const tools = await ctx.tool.transform((editor) => {
    editor.add({
      name: "generate_image",
      description: DESCRIPTION,
      input: INPUT,
      options: { codemode: false },
      execute: async (raw, call) => {
        const input = raw as Input
        const started = Date.now()
        const format = input.format ?? "png"
        const params = {
          prompt: input.prompt,
          size: input.size ?? "1024x1024",
          quality: input.quality ?? "medium",
          background: input.background ?? "auto",
        }
        if (params.background === "transparent" && format === "jpg")
          throw new Error("투명 배경은 png 또는 webp 에서만 가능합니다. format 을 바꿔 다시 호출하세요.")

        const directory = ctx.location.directory
        const spot = await location(directory, input.name, format)
        try {
          const base = { path: spot.relative, url: spot.url, ...params }
          const done = (value: Status, text: string, extra: Record<string, unknown> = {}) => ({
            content: text,
            metadata: { ...base, ...extra, status: value, ms: Date.now() - started },
          })

          const session = await ctx.session.get({ sessionID: call.sessionID }).catch(() => undefined)
          if (session?.parentID) return done("subagent", output("subagent"))

          const state = await quota.state()
          if (state.kind === "unavailable" || state.kind === "disabled") return done(state.kind, output(state.kind))
          if (state.kind === "known" && state.quota.remaining === 0)
            return done("limited", output("limited", state.quota), { quota: state.quota })

          const messages = await ctx.session.context({ sessionID: call.sessionID }).catch(() => [])
          const user = messages.findLast((message) => message.type === "user")
          if (user?.metadata?.imageGeneration !== true) return done("off", output("off"))

          await ctx.permission.assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "edit",
            resources: [spot.relative],
            save: ["*"],
            metadata: { filepath: spot.absolute },
            source: { type: "tool", messageID: call.messageID, id: call.id },
          })

          const callID = call.id || randomUUID()
          const result = await quota.withReservation(callID, async (reserved) => {
            await call.progress({ title: spot.relative, metadata: { ...base, status: "generating" } }).catch(() => {})
            const outcome = await request({ ...params, format: FORMATS[format] })
            if (outcome.kind === "blocked")
              return { kept: false, value: done("blocked", output("blocked"), { reason: outcome.reason }) }
            if (outcome.kind === "timeout") return { kept: true, value: done("timeout", output("timeout")) }

            reporter?.enqueue(
              toolAttributes({
                directory,
                messageID: call.messageID,
                modelID: MODEL,
                tokens: { input: outcome.usage?.input_tokens ?? 0, output: outcome.usage?.output_tokens ?? 0 },
                cost: cost(outcome.usage),
                at: Date.now(),
              }),
              `${call.messageID}:${callID}:tool`,
            )
            await mkdir(path.dirname(spot.absolute), { recursive: true })
            await writeFile(spot.absolute, outcome.bytes)

            const left =
              reserved === undefined ? "" : ` 이 팀이 더 만들 수 있는 이미지는 ${reserved.remaining}장입니다.`
            return {
              kept: true,
              value: done(
                "generated",
                `이미지를 ${spot.relative} 에 저장했습니다 (${params.size}, ${FORMATS[format]}). 웹 페이지에서는 "${spot.url}" 경로로 참조하세요. 파일은 복사하지 말고 이 한 장을 쓰되, 결과물이 이 폴더를 서빙하지 않으면 서빙되는 폴더로 옮기고 경로를 맞추세요. 이미지는 채팅 화면의 도구 카드에 표시됩니다.${left}`,
                { mime: `image/${FORMATS[format]}`, bytes: outcome.bytes.length, quota: reserved },
              ),
            }
          })

          if (result.status === "reserved") return result.value
          if (result.status === "unavailable") return done("unavailable", output("unavailable"))
          return done("limited", output("limited", result.quota), { quota: result.quota })
        } finally {
          spot.release()
        }
      },
    })
  })

  return async () => {
    await tools.dispose()
    await registration.dispose()
  }
}

export * as Image from "./image"
