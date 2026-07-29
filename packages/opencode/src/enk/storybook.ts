/**
 * 바이브 동화책(storybook) 모드 공유 로직.
 *
 * docker/storybook-plugin.js 로 번들되어 파드 안에서 실행되므로 opencode 내부 모듈을
 * 일절 import 하지 않는다(process.env + fetch 만 사용). 페이지 식별은 ai-usage 와 동일하게
 * mount_path(세션 작업 디렉토리) 규약을 쓴다: 모든 요청에 mount_path 를 실어 보내고
 * rails 가 이를 프로젝트/팀으로 해석한다.
 */
export namespace Storybook {
  export const PAGES_PATH = "/api/v1/storybook_pages"
  export const USAGE_PATH = "/api/v1/ai_usages/do_many"

  export type RailsEnv = { railsUrl: string; token: string }
  export type GeminiEnv = { geminiUrl: string; model: string }

  export function railsEnv(source: Record<string, string | undefined> = process.env): RailsEnv | undefined {
    const railsUrl = source["ENK_HACKATHON_RAILS_URL"]
    const token = source["ENK_AI_USAGE_TOKEN"]
    if (!railsUrl || !token) return undefined
    return { railsUrl: railsUrl.replace(/\/+$/, ""), token }
  }

  export function geminiEnv(source: Record<string, string | undefined> = process.env): GeminiEnv | undefined {
    const geminiUrl = source["GEMINI_BASE_URL"]
    const raw = source["ENK_AI_IMAGE_MODEL"]
    if (!geminiUrl || !raw) return undefined
    return { geminiUrl: geminiUrl.replace(/\/+$/, ""), model: parseImageModelId(raw) }
  }

  /** ENK_AI_IMAGE_MODEL 은 "provider/model" 또는 모델 id 단독을 허용한다. REST 경로에는 모델 id 만 쓴다. */
  export function parseImageModelId(raw: string): string {
    const index = raw.indexOf("/")
    if (index < 0) return raw
    return raw.slice(index + 1)
  }

  export type Page = {
    id: string
    position: number
    text?: string
    image_prompt?: string
    image_status?: string
  }

  export type PageAttributes = {
    mount_path?: string
    position?: number
    text?: string
    image_prompt?: string
    image_status?: "generating" | "succeeded" | "failed" | "blocked"
    image_base64?: string
  }

  export function pageFromResource(resource: unknown): Page | undefined {
    if (typeof resource !== "object" || resource === null) return undefined
    const { id, attributes } = resource as { id?: unknown; attributes?: Record<string, unknown> }
    if (id === undefined || id === null) return undefined
    const position = Number(attributes?.["position"])
    if (!Number.isInteger(position)) return undefined
    return {
      id: String(id),
      position,
      text: typeof attributes?.["text"] === "string" ? (attributes["text"] as string) : undefined,
      image_prompt: typeof attributes?.["image_prompt"] === "string" ? (attributes["image_prompt"] as string) : undefined,
      image_status: typeof attributes?.["image_status"] === "string" ? (attributes["image_status"] as string) : undefined,
    }
  }

  export function findByPosition(pages: Page[], position: number): Page | undefined {
    return pages.find((page) => page.position === position)
  }

  /** JSON:API 에러 응답에서 사람이 읽을 메시지를 뽑는다. */
  export function errorDetail(body: unknown): string | undefined {
    if (typeof body !== "object" || body === null) return undefined
    const errors = (body as { errors?: unknown }).errors
    if (!Array.isArray(errors)) return undefined
    const messages = errors
      .map((error) => {
        if (typeof error !== "object" || error === null) return undefined
        const { detail, title } = error as { detail?: unknown; title?: unknown }
        if (typeof detail === "string" && detail) return detail
        if (typeof title === "string" && title) return title
        return undefined
      })
      .filter((message): message is string => Boolean(message))
    if (!messages.length) return undefined
    return messages.join(" / ")
  }

  export class RailsError extends Error {
    constructor(
      readonly status: number,
      readonly detail?: string,
    ) {
      super(detail ? `rails ${status}: ${detail}` : `rails ${status}`)
    }
  }

  async function railsFetch(
    env: RailsEnv,
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const res = await fetch(env.railsUrl + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `token ${env.token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    const json = await res.json().catch(() => undefined)
    if (!res.ok) throw new RailsError(res.status, errorDetail(json))
    return json
  }

  export async function listPages(env: RailsEnv, mountPath: string, signal?: AbortSignal): Promise<Page[]> {
    const json = await railsFetch(
      env,
      "GET",
      `${PAGES_PATH}?filter[mount_path]=${encodeURIComponent(mountPath)}`,
      undefined,
      signal,
    )
    const data = (json as { data?: unknown })?.data
    if (!Array.isArray(data)) return []
    return data.map(pageFromResource).filter((page): page is Page => Boolean(page))
  }

  export async function createPage(
    env: RailsEnv,
    mountPath: string,
    attributes: PageAttributes,
    signal?: AbortSignal,
  ): Promise<Page | undefined> {
    const json = await railsFetch(
      env,
      "POST",
      PAGES_PATH,
      { data: { type: "storybook_pages", attributes: { ...attributes, mount_path: mountPath } } },
      signal,
    )
    return pageFromResource((json as { data?: unknown })?.data)
  }

  export async function updatePage(
    env: RailsEnv,
    mountPath: string,
    id: string,
    attributes: PageAttributes,
    signal?: AbortSignal,
  ): Promise<void> {
    await railsFetch(
      env,
      "PUT",
      `${PAGES_PATH}/${encodeURIComponent(id)}`,
      { data: { type: "storybook_pages", id, attributes: { ...attributes, mount_path: mountPath } } },
      signal,
    )
  }

  export async function deletePage(env: RailsEnv, id: string, signal?: AbortSignal): Promise<void> {
    await railsFetch(env, "DELETE", `${PAGES_PATH}/${encodeURIComponent(id)}`, undefined, signal)
  }

  // Gemini generateContent — 이미지 출력 모델용 REST 형태.
  // 조정 가능한 모든 유해 카테고리에 가장 엄격한 BLOCK_LOW_AND_ABOVE 를 적용한다.
  export const SAFETY_CATEGORIES = [
    "HARM_CATEGORY_HARASSMENT",
    "HARM_CATEGORY_HATE_SPEECH",
    "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    "HARM_CATEGORY_DANGEROUS_CONTENT",
  ] as const

  export function buildImageRequest(prompt: string) {
    return {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      safetySettings: SAFETY_CATEGORIES.map((category) => ({ category, threshold: "BLOCK_LOW_AND_ABOVE" })),
    }
  }

  export type ImageUsage = { input: number; output: number; reasoning: number; total: number }

  export type ImageResult =
    | { kind: "image"; mimeType: string; data: string; usage: ImageUsage }
    | { kind: "blocked"; reason: string; usage: ImageUsage }
    | { kind: "empty"; reason?: string; usage: ImageUsage }

  const BLOCK_FINISH_REASONS = new Set([
    "SAFETY",
    "IMAGE_SAFETY",
    "IMAGE_PROHIBITED_CONTENT",
    "PROHIBITED_CONTENT",
    "RECITATION",
    "BLOCKLIST",
    "SPII",
  ])

  export function parseImageResponse(json: unknown): ImageResult {
    const body = (typeof json === "object" && json !== null ? json : {}) as {
      promptFeedback?: { blockReason?: string }
      candidates?: {
        finishReason?: string
        content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] }
      }[]
      usageMetadata?: {
        promptTokenCount?: number
        candidatesTokenCount?: number
        thoughtsTokenCount?: number
        totalTokenCount?: number
      }
    }
    const meta = body.usageMetadata ?? {}
    const usage: ImageUsage = {
      input: meta.promptTokenCount ?? 0,
      output: meta.candidatesTokenCount ?? 0,
      reasoning: meta.thoughtsTokenCount ?? 0,
      total: meta.totalTokenCount ?? 0,
    }

    const blockReason = body.promptFeedback?.blockReason
    if (blockReason) return { kind: "blocked", reason: blockReason, usage }

    const candidate = body.candidates?.[0]
    const finishReason = candidate?.finishReason
    if (finishReason && BLOCK_FINISH_REASONS.has(finishReason)) {
      return { kind: "blocked", reason: finishReason, usage }
    }

    for (const part of candidate?.content?.parts ?? []) {
      const inline = part.inlineData
      if (inline?.data) return { kind: "image", mimeType: inline.mimeType ?? "image/png", data: inline.data, usage }
    }
    return { kind: "empty", reason: finishReason, usage }
  }

  export async function generateImage(env: GeminiEnv, prompt: string, signal?: AbortSignal): Promise<ImageResult> {
    const res = await fetch(`${env.geminiUrl}/models/${env.model}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // CHP 프록시가 키를 주입한다 — docker/opencode.jsonc 의 google.options.apiKey 와 동일한 자리표시자.
        "x-goog-api-key": "proxy-auth",
      },
      body: JSON.stringify(buildImageRequest(prompt)),
      signal,
    })
    const json = await res.json().catch(() => undefined)
    if (!res.ok) {
      throw new Error(`gemini ${res.status}: ${JSON.stringify(json)?.slice(0, 300) ?? "no body"}`)
    }
    return parseImageResponse(json)
  }

  /**
   * 이미지 호출 1건을 ai_usages/do_many 에 채팅 스텝 레코드(enk/ai-usage.ts Attributes)와
   * 같은 형태로 보고한다. message_id 에 `:img:{callID}` 를 붙여 같은 어시스턴트 턴의 채팅
   * 스텝 레코드와 (message_id, step_index, phase) 멱등키가 절대 충돌하지 않게 한다.
   */
  export function buildImageUsageRecord(input: {
    mountPath: string
    modelId: string
    messageId: string
    callId: string
    usage: ImageUsage
    at?: number
  }) {
    return {
      mount_path: input.mountPath,
      model_id: input.modelId,
      message_id: `${input.messageId}:img:${input.callId}`,
      step_index: 0,
      phase: "step" as const,
      tokens: input.usage.total || input.usage.input + input.usage.output + input.usage.reasoning,
      input: input.usage.input,
      output: input.usage.output,
      reasoning: input.usage.reasoning,
      cache_read: 0,
      cache_write: 0,
      cost: 0,
      used_at: new Date(input.at ?? Date.now()).toISOString(),
    }
  }

  export async function reportImageUsage(
    env: RailsEnv,
    record: ReturnType<typeof buildImageUsageRecord>,
  ): Promise<void> {
    await fetch(env.railsUrl + USAGE_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `token ${env.token}`,
      },
      body: JSON.stringify({ data_to_create: [{ type: "ai-usages", attributes: record }] }),
    })
  }
}
