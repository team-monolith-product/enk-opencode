import z from "zod"
import path from "path"
import { randomUUID } from "node:crypto"
import { readdir } from "node:fs/promises"
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

  export type Status = "generated" | "off" | "blocked" | "timeout" | "limited" | "disabled" | "unavailable"

  export type Metadata = {
    status: Status
    path: string
    url?: string
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

  // AI 가 만든 이미지는 한 폴더에 모은다. 결과물이 정적 파일을 서빙하는 폴더 아래에 두고, 브라우저가 어느 페이지에서든
  // 불러올 수 있게 / 로 시작하는 경로를 돌려준다.
  async function servedRoot() {
    const dir = Instance.directory
    if (await Filesystem.isDir(path.join(dir, "public")))
      return { folder: path.join("public", FOLDER), url: `/${FOLDER}` }
    if (await Filesystem.isDir(path.join(dir, "static")))
      return { folder: path.join("static", FOLDER), url: `/static/${FOLDER}` }
    const apps = (await readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
      .map((entry) => entry.name)
    const nested = []
    for (const app of apps)
      if (
        (await Filesystem.exists(path.join(dir, app, "package.json"))) &&
        (await Filesystem.isDir(path.join(dir, app, "public")))
      )
        nested.push(app)
    if (nested.length === 1) return { folder: path.join(nested[0]!, "public", FOLDER), url: `/${FOLDER}` }
    return { folder: FOLDER, url: `/${FOLDER}` }
  }

  // 같은 이름으로 동시에 그려도 서로 덮어쓰지 않게, 저장이 끝날 때까지 고른 경로를 잡아 둔다.
  const claimed = new Set<string>()

  export async function location(name: string, ext: Extension) {
    const root = await servedRoot()
    const stem = slug(name)
    for (let n = 1; ; n++) {
      const file = `${n === 1 ? stem : `${stem}-${n}`}${ext}`
      const relative = path.join(root.folder, file)
      const absolute = path.join(Instance.directory, relative)
      if (await Filesystem.exists(absolute)) continue
      if (claimed.has(absolute)) continue
      claimed.add(absolute)
      return { relative, url: `${root.url}/${file}`, [Symbol.dispose]: () => claimed.delete(absolute) }
    }
  }

  export const FOLDER = "ai-images"

  export function slug(name: string) {
    const base = path.basename(name).replace(/\.[^.]*$/, "")
    const cleaned = base
      .normalize("NFC")
      .replace(/[^\p{L}\p{N}_-]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
    return cleaned || "image"
  }

  export function mime(format: string) {
    return `image/${format}`
  }

  export type Request = {
    prompt: string
    size: string
    quality: string
    background: string
    format: (typeof FORMATS)[Extension]
  }

  export type Outcome =
    | { kind: "image"; bytes: Buffer; usage?: Usage }
    | { kind: "blocked"; reason?: string }
    | { kind: "timeout" }

  /**
   * OpenAI Images 호출. 학생이 응답을 멈춰도 끊지 않는다 — 이미 청구된 그림을 버리지 않고 저장·과금·개수에 반영한다.
   * 안전 정책 거절과 시간 초과만 결과로 돌려주고 나머지 실패는 던진다.
   */
  export async function request(input: Request): Promise<Outcome> {
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
    }).catch((err) => {
      if (err instanceof Error && err.name === "TimeoutError") return undefined
      throw err
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

  export function output(status: Exclude<Status, "generated">, quota?: ImageQuota.Quota) {
    return {
      off: "학생이 이번 메시지에서 입력창의 '이미지 만들기'를 꺼 두어 그리지 않았습니다. 다시 호출하지 말고, 그림이 꼭 필요하면 '이미지 만들기'를 켜고 다시 요청해 달라고 짧게 안내하세요. 토글은 메시지마다 바뀌므로 켜진 메시지에서는 이 도구로 그릴 수 있습니다.",
      unavailable: `이 작업 공간에서는 이미지 생성을 쓸 수 없습니다. ${REFUSAL}`,
      disabled: `이 해커톤에서는 이미지 생성을 사용하지 않습니다. ${REFUSAL}`,
      limited: `이 팀이 만들 수 있는 이미지 ${quota?.limit}장을 모두 사용했습니다. ${REFUSAL}`,
      blocked:
        "안전 정책에 걸려 이미지를 만들지 못했습니다(이번 시도는 개수에서 빠집니다). 학생에게 짧게 알리고, 실존 인물·상표·폭력적 표현을 뺀 오리지널 디자인으로 프롬프트를 바꿔 제안하세요.",
      timeout:
        "이미지 생성이 너무 오래 걸려 그림을 받지 못했습니다. 생성 비용이 이미 나갔을 수 있어 이번 시도는 개수에 남습니다. 같은 그림을 바로 다시 요청하지 말고 학생에게 짧게 알리세요.",
    }[status]
  }
}

export const GenerateImageTool = Tool.define("generate_image", {
  description: DESCRIPTION,
  parameters: z.object({
    prompt: z.string().min(1).describe("그릴 내용을 구체적으로 묘사한 프롬프트"),
    name: z.string().describe("파일 이름. 내용을 알 수 있는 짧은 영문 이름 (예: hero-cat). 폴더는 도구가 정한다"),
    format: z.enum(["png", "webp", "jpg"]).default("png"),
    size: z.enum(["1024x1024", "1536x1024", "1024x1536"]).default("1024x1024"),
    quality: z.enum(["low", "medium", "high"]).default("medium"),
    background: z.enum(["auto", "transparent", "opaque"]).default("auto"),
  }),
  async execute(params, ctx) {
    const startedAt = Date.now()
    const ext = `.${params.format}` as GenerateImage.Extension
    const format = GenerateImage.FORMATS[ext]
    if (params.background === "transparent" && format === "jpeg")
      throw new Error("투명 배경은 png 또는 webp 에서만 가능합니다. format 을 바꿔 다시 호출하세요.")

    using spot = await GenerateImage.location(params.name, ext)
    const { relative, url } = spot
    const filepath = path.join(Instance.directory, relative)
    const base = {
      path: relative,
      url,
      prompt: params.prompt,
      size: params.size,
      quality: params.quality,
      background: params.background,
    }
    const done = (status: GenerateImage.Status, output: string, extra: Partial<GenerateImage.Metadata> = {}) => ({
      title: relative,
      output,
      metadata: { ...base, ...extra, status, ms: Date.now() - startedAt } satisfies GenerateImage.Metadata,
    })

    const state = ImageQuota.state()
    if (state.kind === "unavailable" || state.kind === "disabled")
      return done(state.kind, GenerateImage.output(state.kind))
    if (state.kind === "known" && state.quota.remaining === 0)
      return done("limited", GenerateImage.output("limited", state.quota), { quota: state.quota })

    const user = ctx.messages.findLast((m) => m.info.role === "user")?.info
    if (user?.role !== "user" || user.imageGeneration !== true) return done("off", GenerateImage.output("off"))

    await assertExternalDirectory(ctx, filepath)
    await ctx.ask({
      permission: "edit",
      patterns: [path.relative(Instance.worktree, filepath)],
      always: ["*"],
      metadata: { filepath },
    })

    const callID = ctx.callID || randomUUID()
    const result = await ImageQuota.withReservation(callID, async (quota) => {
      ctx.metadata({ title: relative, metadata: { ...base, status: "generating" } })
      const outcome = await GenerateImage.request({ ...base, format })
      if (outcome.kind === "blocked")
        return { kept: false, value: done("blocked", GenerateImage.output("blocked"), { reason: outcome.reason }) }
      if (outcome.kind === "timeout") return { kept: true, value: done("timeout", GenerateImage.output("timeout")) }

      AiUsage.reportTool({
        cwd: Instance.directory,
        messageID: ctx.messageID,
        callID,
        modelID: GenerateImage.MODEL,
        tokens: { input: outcome.usage?.input_tokens ?? 0, output: outcome.usage?.output_tokens ?? 0 },
        cost: GenerateImage.cost(outcome.usage),
      })
      await Filesystem.write(filepath, outcome.bytes)
      Bus.publish(File.Event.Edited, { file: filepath })
      await Bus.publish(FileWatcher.Event.Updated, { file: filepath, event: "add" })
      await FileTime.read(ctx.sessionID, filepath)

      const left = quota === undefined ? "" : ` 이 팀이 더 만들 수 있는 이미지는 ${quota.remaining}장입니다.`
      return {
        kept: true,
        value: done(
          "generated",
          `이미지를 ${relative} 에 저장했습니다 (${params.size}, ${format}). 웹 페이지에서는 "${url}" 경로로 참조하세요. 파일은 복사하지 말고 이 한 장을 쓰되, 결과물이 이 폴더를 서빙하지 않으면 서빙되는 폴더로 옮기고 경로를 맞추세요. 이미지는 채팅 화면의 도구 카드에 표시됩니다.${left}`,
          { mime: GenerateImage.mime(format), bytes: outcome.bytes.length, quota },
        ),
      }
    })

    if (result.status === "reserved") return result.value
    if (result.status === "unavailable") return done("unavailable", GenerateImage.output("unavailable"))
    return done("limited", GenerateImage.output("limited", result.quota), { quota: result.quota })
  },
})
