import z from "zod"
import path from "path"
import { randomUUID } from "node:crypto"
import { Tool } from "./tool"
import DESCRIPTION from "./generate-image.txt"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { FileTime } from "../file/time"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { AiUsage } from "../enk/ai-usage"
import { ImageQuota } from "../enk/image-quota"
import { assertExternalDirectory } from "./external-directory"

export namespace GenerateImage {
  export const MODEL = "gpt-image-1-mini"
  // USD per 1M tokens — https://developers.openai.com/api/docs/pricing
  const PRICE = { text: 2, image: 2.5, output: 8 }
  export const TIMEOUT_MS = 180_000

  export const FORMATS = { ".png": "png", ".webp": "webp", ".jpg": "jpeg", ".jpeg": "jpeg" } as const
  export type Extension = keyof typeof FORMATS

  export type Usage = {
    input_tokens?: number
    output_tokens?: number
    input_tokens_details?: { text_tokens?: number; image_tokens?: number }
  }

  export type Metadata = {
    status: "generated" | "blocked" | "limited" | "disabled" | "unavailable"
    path: string
    prompt: string
    size: string
    quality: string
    background: string
    mime?: string
    bytes?: number
    ms: number
    reason?: string
    quota?: ImageQuota.Quota
  }

  export function cost(usage: Usage | undefined) {
    if (!usage) return 0
    const input = usage.input_tokens ?? 0
    const image = usage.input_tokens_details?.image_tokens ?? 0
    const text = usage.input_tokens_details?.text_tokens ?? input - image
    return (text * PRICE.text + image * PRICE.image + (usage.output_tokens ?? 0) * PRICE.output) / 1_000_000
  }

  // 파드에서는 CHP 가 OPENAI_BASE_URL 로 실키를 주입하고, 로컬에서는 OPENAI_API_KEY 로 직접 부른다.
  export function endpoint() {
    const key = process.env["OPENAI_API_KEY"]
    const base = process.env["OPENAI_BASE_URL"] ?? (key ? "https://api.openai.com/v1" : undefined)
    if (!base) return
    return { url: base.replace(/\/+$/, "") + "/images/generations", key: key ?? "proxy-auth" }
  }

  export function available() {
    return endpoint() !== undefined
  }

  export function mime(format: string) {
    return `image/${format}`
  }
}

export const GenerateImageTool = Tool.define("generate_image", {
  description: DESCRIPTION,
  parameters: z.object({
    prompt: z.string().min(1).describe("그릴 내용을 구체적으로 묘사한 프롬프트"),
    path: z.string().describe("저장할 파일 경로 (.png, .webp, .jpg). 예: public/images/hero.png"),
    size: z.enum(["1024x1024", "1536x1024", "1024x1536"]).default("1024x1024"),
    quality: z.enum(["low", "medium", "high"]).default("medium"),
    background: z.enum(["auto", "transparent", "opaque"]).default("auto"),
  }),
  async execute(params, ctx) {
    const startedAt = Date.now()
    const filepath = path.isAbsolute(params.path) ? params.path : path.join(Instance.directory, params.path)
    const relative = path.relative(Instance.directory, filepath)
    const ext = path.extname(filepath).toLowerCase()
    if (!(ext in GenerateImage.FORMATS))
      throw new Error(`지원하지 않는 확장자입니다: ${ext || "(없음)"}. .png, .webp, .jpg 중 하나로 저장하세요.`)
    const format = GenerateImage.FORMATS[ext as GenerateImage.Extension]
    if (params.background === "transparent" && format === "jpeg")
      throw new Error("투명 배경은 .png 또는 .webp 에서만 가능합니다. 확장자를 바꿔 다시 호출하세요.")

    const api = GenerateImage.endpoint()
    if (!api) throw new Error("이미지 생성이 설정되지 않은 환경입니다 (OPENAI_BASE_URL / OPENAI_API_KEY 없음).")
    const openai = api

    await assertExternalDirectory(ctx, filepath)
    await ctx.ask({
      permission: "edit",
      patterns: [path.relative(Instance.worktree, filepath)],
      always: ["*"],
      metadata: { filepath },
    })

    const base = {
      path: relative,
      prompt: params.prompt,
      size: params.size,
      quality: params.quality,
      background: params.background,
    }
    const callID = ctx.callID || randomUUID()
    const reservation = await ImageQuota.reserve(callID)
    if (reservation.status !== "reserved") {
      const status =
        reservation.status === "unavailable" ? "unavailable" : reservation.quota.limit === 0 ? "disabled" : "limited"
      const metadata: GenerateImage.Metadata = {
        ...base,
        status,
        ms: Date.now() - startedAt,
        quota: reservation.status === "exhausted" ? reservation.quota : undefined,
      }
      const output = {
        unavailable: "이 작업 공간에서는 이미지 생성을 쓸 수 없습니다.",
        disabled: "이 해커톤에서는 이미지 생성을 사용하지 않습니다.",
        limited: `이 팀이 만들 수 있는 이미지 ${metadata.quota?.limit}장을 모두 사용했습니다.`,
      }[status]
      return {
        title: relative,
        output: `${output} 다시 호출하지 말고, 학생에게 짧게 알린 뒤 CSS·SVG·이모지 등 이미지 파일 없이 표현하는 방법을 제안하세요.`,
        metadata,
      }
    }
    const remaining = reservation.quota?.remaining

    ctx.metadata({ title: relative, metadata: { ...base, status: "generating" } })

    const generated = await generate().catch(async (err) => {
      await ImageQuota.release(callID)
      throw err
    })
    if (!generated.ok) {
      await ImageQuota.release(callID)
      return generated.result
    }
    const { body, b64 } = generated

    AiUsage.reportTool({
      cwd: Instance.directory,
      messageID: ctx.messageID,
      callID,
      modelID: GenerateImage.MODEL,
      tokens: { input: body.usage?.input_tokens ?? 0, output: body.usage?.output_tokens ?? 0 },
      cost: GenerateImage.cost(body.usage),
    })

    const bytes = Buffer.from(b64, "base64")
    const exists = await Filesystem.exists(filepath)
    await Filesystem.write(filepath, bytes)
    Bus.publish(File.Event.Edited, { file: filepath })
    await Bus.publish(FileWatcher.Event.Updated, { file: filepath, event: exists ? "change" : "add" })
    await FileTime.read(ctx.sessionID, filepath)

    const metadata: GenerateImage.Metadata = {
      ...base,
      status: "generated",
      mime: GenerateImage.mime(format),
      bytes: bytes.length,
      ms: Date.now() - startedAt,
      quota: reservation.quota,
    }
    return {
      title: relative,
      output:
        `이미지를 ${relative} 에 저장했습니다 (${params.size}, ${format}). 코드에서는 이 경로로 참조하세요. 이미지는 학생 채팅 화면에 이미 표시되었습니다.` +
        (remaining === undefined ? "" : ` 이 팀이 더 만들 수 있는 이미지는 ${remaining}장입니다.`),
      metadata,
    }

    async function generate() {
      const res = await fetch(openai.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${openai.key}` },
        body: JSON.stringify({
          model: GenerateImage.MODEL,
          prompt: params.prompt,
          n: 1,
          size: params.size,
          quality: params.quality,
          background: params.background,
          output_format: format,
        }),
        signal: AbortSignal.any([ctx.abort, AbortSignal.timeout(GenerateImage.TIMEOUT_MS)]),
      })
      const body = (await res.json().catch(() => undefined)) as
        | { data?: { b64_json?: string }[]; usage?: GenerateImage.Usage; error?: { code?: string; message?: string } }
        | undefined

      if (!res.ok) {
        if (body?.error?.code === "moderation_blocked") {
          const metadata: GenerateImage.Metadata = {
            ...base,
            status: "blocked",
            ms: Date.now() - startedAt,
            reason: body.error.message,
          }
          return {
            ok: false as const,
            result: {
              title: relative,
              output:
                "안전 정책에 걸려 이미지를 만들지 못했습니다(이번 시도는 개수에서 빠집니다). 학생에게 짧게 알리고, 실존 인물·상표·폭력적 표현을 뺀 오리지널 디자인으로 프롬프트를 바꿔 제안하세요.",
              metadata,
            },
          }
        }
        throw new Error(`이미지 생성 실패 (${res.status}): ${body?.error?.message ?? res.statusText}`)
      }

      const b64 = body?.data?.[0]?.b64_json
      if (!b64) throw new Error("이미지 생성 응답에 이미지가 없습니다.")
      return { ok: true as const, body, b64 }
    }
  },
})
