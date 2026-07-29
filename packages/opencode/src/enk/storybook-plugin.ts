// 바이브 동화책(storybook) 툴 플러그인 (opencode).
//
// 동화책 모드 파드에만 로드된다: 스포너가 OPENCODE_CONFIG_CONTENT 로
// "plugin": ["/etc/opencode/storybook-plugin.js"] 를 주입한다(코딩 모드에는 툴 자체가 없다).
// 페이지 CRUD 는 rails storybook_pages API 로, 삽화는 Gemini(generateContent, CHP 프록시)로 처리하며
// 모든 요청은 mount_path(세션 작업 디렉토리)로 프로젝트를 식별한다 — src/enk/storybook.ts 참고.
//
// 빌드: packages/opencode 에서 `bun run build:storybook-plugin` → docker/storybook-plugin.js

import { z } from "zod"
import { Storybook } from "./storybook"

const log = (...args: unknown[]) => console.error("[storybook-plugin]", ...args)

const GEMINI_TIMEOUT_MS = 120_000

type ToolContext = {
  sessionID: string
  messageID: string
  agent: string
  directory: string
  abort: AbortSignal
  callID?: string
}

const QUOTA_MESSAGE = "팀의 그림 생성 한도를 모두 사용해서 새 그림을 저장할 수 없어요. 글을 다듬거나 이미 만든 그림을 활용해 주세요."
const BLOCKED_MESSAGE = "이 그림 내용은 어린이 동화에 알맞지 않다고 판단되어 만들 수 없었어요. 더 밝고 따뜻한 장면으로 바꿔서 다시 시도해 주세요."

function friendly(error: unknown): string {
  if (error instanceof Storybook.RailsError) {
    if (error.status === 401 || error.status === 403) return "동화책 저장소에 접근할 수 없어요. 잠시 후 다시 시도해 주세요."
    if (error.detail) return `동화책 저장에 실패했어요: ${error.detail}`
    return "동화책 저장에 실패했어요. 잠시 후 다시 시도해 주세요."
  }
  return "동화책 저장소와 통신하지 못했어요. 잠시 후 다시 시도해 주세요."
}

async function server({ directory }: { directory?: string }) {
  const rails = Storybook.railsEnv()
  if (!rails || !directory) {
    log("storybook tools disabled: ENK_HACKATHON_RAILS_URL/ENK_AI_USAGE_TOKEN or directory missing")
    return {}
  }
  const mountPath = directory

  const upsert_page = {
    description:
      "동화책 페이지를 만들거나 수정합니다. position 쪽 페이지가 없으면 새로 만들고, 있으면 전달한 필드만 갱신합니다. 페이지 글은 반드시 이 도구로만 저장하세요.",
    args: {
      position: z.number().int().min(1).describe("페이지 번호(1부터 시작)"),
      text: z.string().optional().describe("이 페이지에 들어갈 동화 본문"),
      image_prompt: z.string().optional().describe("이 페이지 삽화에 대한 묘사(그림 생성 전 미리 저장용)"),
    },
    async execute(args: { position: number; text?: string; image_prompt?: string }, ctx: ToolContext) {
      try {
        const pages = await Storybook.listPages(rails, mountPath, ctx.abort)
        const existing = Storybook.findByPosition(pages, args.position)
        const attributes: Storybook.PageAttributes = {}
        if (args.text !== undefined) attributes.text = args.text
        if (args.image_prompt !== undefined) attributes.image_prompt = args.image_prompt
        if (existing) {
          await Storybook.updatePage(rails, mountPath, existing.id, attributes, ctx.abort)
          return `${args.position}쪽 페이지를 수정했어요.`
        }
        await Storybook.createPage(rails, mountPath, { ...attributes, position: args.position }, ctx.abort)
        return `${args.position}쪽 페이지를 만들었어요.`
      } catch (error) {
        log("upsert_page failed:", error)
        return friendly(error)
      }
    },
  }

  const delete_page = {
    description: "동화책에서 position 쪽 페이지를 삭제합니다.",
    args: {
      position: z.number().int().min(1).describe("삭제할 페이지 번호"),
    },
    async execute(args: { position: number }, ctx: ToolContext) {
      try {
        const pages = await Storybook.listPages(rails, mountPath, ctx.abort)
        const existing = Storybook.findByPosition(pages, args.position)
        if (!existing) return `${args.position}쪽 페이지가 없어서 삭제할 것이 없어요.`
        await Storybook.deletePage(rails, existing.id, ctx.abort)
        return `${args.position}쪽 페이지를 삭제했어요.`
      } catch (error) {
        log("delete_page failed:", error)
        return friendly(error)
      }
    },
  }

  const generate_illustration = {
    description:
      "position 쪽 페이지의 삽화를 그립니다. image_prompt 로 장면을 묘사하면 그림을 생성해 페이지에 저장합니다. 캐릭터의 생김새·옷차림을 매번 똑같이 묘사해서 페이지끼리 일관성을 지키세요.",
    args: {
      position: z.number().int().min(1).describe("삽화를 넣을 페이지 번호"),
      image_prompt: z.string().min(1).describe("그림으로 그릴 장면 묘사(캐릭터 외형 묘사 포함, 구체적으로)"),
    },
    async execute(args: { position: number; image_prompt: string }, ctx: ToolContext) {
      const gemini = Storybook.geminiEnv()
      if (!gemini) return "그림 생성 기능이 아직 준비되지 않았어요. 글 먼저 완성해 볼까요?"

      let pageId: string
      try {
        const pages = await Storybook.listPages(rails, mountPath, ctx.abort)
        const existing = Storybook.findByPosition(pages, args.position)
        const attributes: Storybook.PageAttributes = { image_prompt: args.image_prompt, image_status: "generating" }
        if (existing) {
          await Storybook.updatePage(rails, mountPath, existing.id, attributes, ctx.abort)
          pageId = existing.id
        } else {
          const created = await Storybook.createPage(
            rails,
            mountPath,
            { ...attributes, position: args.position },
            ctx.abort,
          )
          if (!created) return "페이지를 준비하지 못했어요. 잠시 후 다시 시도해 주세요."
          pageId = created.id
        }
      } catch (error) {
        log("generate_illustration prepare failed:", error)
        return friendly(error)
      }

      const markFailed = async (status: "failed" | "blocked") => {
        await Storybook.updatePage(rails, mountPath, pageId, { image_status: status }).catch((error) =>
          log("image_status update failed:", error),
        )
      }

      let result: Storybook.ImageResult
      try {
        const signal = AbortSignal.any([ctx.abort, AbortSignal.timeout(GEMINI_TIMEOUT_MS)])
        result = await Storybook.generateImage(gemini, args.image_prompt, signal)
      } catch (error) {
        log("gemini call failed:", error)
        await markFailed("failed")
        return "그림 그리기에 실패했어요. 잠시 후 다시 시도해 주세요."
      }

      Storybook.reportImageUsage(
        rails,
        Storybook.buildImageUsageRecord({
          mountPath,
          modelId: gemini.model,
          messageId: ctx.messageID,
          callId: ctx.callID ?? `${args.position}:${Date.now()}`,
          usage: result.usage,
        }),
      ).catch((error) => log("image usage report failed:", error))

      if (result.kind === "blocked") {
        await markFailed("blocked")
        return BLOCKED_MESSAGE
      }
      if (result.kind === "empty") {
        await markFailed("failed")
        return "그림이 만들어지지 않았어요. 장면 묘사를 조금 더 구체적으로 바꿔서 다시 시도해 주세요."
      }

      try {
        await Storybook.updatePage(rails, mountPath, pageId, {
          image_status: "succeeded",
          image_base64: result.data,
        })
      } catch (error) {
        log("image upload failed:", error)
        await markFailed("failed")
        if (error instanceof Storybook.RailsError && error.status === 422) {
          return error.detail ? `${QUOTA_MESSAGE} (${error.detail})` : QUOTA_MESSAGE
        }
        return friendly(error)
      }

      return `${args.position}쪽 삽화를 완성했어요.`
    },
  }

  return {
    tool: { upsert_page, delete_page, generate_illustration },
  }
}

export default { id: "enk-storybook", server }
