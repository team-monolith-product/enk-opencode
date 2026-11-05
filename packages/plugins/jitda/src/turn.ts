import type { Plugin } from "@opencode/plugin"
import type { Locale } from "./locale"
import type { WorkspaceRepo } from "./workspace-repo"

// 대화 한 턴(마지막 요청과 그 답)을 읽어 그 턴에 바뀐 파일을 설명하는 커밋 메시지를 짓는다.

type Context = Plugin.Context

const MAX_FILES = 30
const MAX_SUBJECT = 72

const LABEL = {
  ko: {
    A: "추가",
    M: "수정",
    D: "삭제",
    fallback: "짓다에서 작업한 내용",
    first: "짓다에서 처음 올린 내용",
    manual: "짓다에서 직접 올린 내용",
  },
  en: {
    A: "Add",
    M: "Update",
    D: "Delete",
    fallback: "Update from Jitda",
    first: "First push from Jitda",
    manual: "Manual push from Jitda",
  },
} as const

const label = (locale: Locale.Locale = "ko") => LABEL[locale === "ko" ? "ko" : "en"]

export type Turn = {
  id: string
  request: string
  reply: string
  locale: Locale.Locale
  model?: { providerID: string; id: string }
}

export type Message = {
  id: string
  type: string
  text?: string
  content?: Array<{ type: string; text?: string }>
  metadata?: Record<string, unknown>
  model?: { providerID: string; id: string }
}

export function compose(subject: string, changes: WorkspaceRepo.Change[], locale?: Locale.Locale) {
  const words = label(locale)
  const lines = changes.slice(0, MAX_FILES).map((change) => `- ${words[change.status]}: ${change.file}`)
  if (changes.length > MAX_FILES) lines.push(`- … +${changes.length - MAX_FILES}`)
  const clipped = subject.length > MAX_SUBJECT ? subject.slice(0, MAX_SUBJECT - 1) + "…" : subject
  return [clipped, ...(lines.length ? ["", ...lines] : [])].join("\n")
}

// 저장소를 만들자마자 올리는 첫 커밋의 제목.
export function first(locale?: Locale.Locale) {
  return label(locale).first
}

// 연결 화면에서 직접 올릴 때 커밋의 제목.
export function manual(locale?: Locale.Locale) {
  return label(locale).manual
}

// 가장 최근 사용자 요청과 그 뒤 마지막 AI 답을 고른다.
export function latest(messages: ReadonlyArray<Message>): Turn | undefined {
  const index = messages.findLastIndex((message) => message.type === "user" && (message.text ?? "").trim())
  const found = messages[index]
  if (!found) return undefined
  const replies = messages.slice(index + 1).filter((message) => message.type === "assistant")
  const reply =
    replies
      .map((message) =>
        (message.content ?? [])
          .flatMap((part) => (part.type === "text" && part.text?.trim() ? [part.text.trim()] : []))
          .join("\n"),
      )
      .filter(Boolean)
      .at(-1) ?? ""
  return {
    id: found.id,
    request: (found.text ?? "").trim(),
    reply,
    locale: found.metadata?.locale === "en" || found.metadata?.locale === "ar" ? found.metadata.locale : "ko",
    model: replies.at(-1)?.model,
  }
}

// 메인 세션의 마지막 턴. 하위 세션(서브에이전트)이 끝난 것은 턴으로 치지 않는다.
export async function current(ctx: Context, sessionID: string) {
  const session = await ctx.session.get({ sessionID })
  if ((session as { parentID?: string }).parentID) return
  return latest((await ctx.session.context({ sessionID })) as unknown as Message[])
}

export async function describe(ctx: Context, turn: Turn, changes: WorkspaceRepo.Change[]) {
  const content = [turn.request, turn.reply].filter(Boolean).join("\n\n").slice(0, 4000)
  const title = turn.model
    ? await ctx.generate
        .text({
          model: turn.model,
          prompt: `Generate a title for the change made in this conversation:\n\n${content}`,
        })
        .then((result) =>
          result.text
            .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
            .split("\n")
            .map((line) => line.trim())
            .find(Boolean),
        )
        .catch((error) => {
          console.error("[jitda.turn] summary failed", String(error))
          return undefined
        })
    : undefined
  const fallback = turn.request
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
  return compose(title || fallback || label(turn.locale).fallback, changes, turn.locale)
}

export * as TurnSummary from "./turn"
