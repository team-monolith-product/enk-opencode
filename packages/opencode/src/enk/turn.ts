import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { Session } from "@/session"
import { LLM } from "@/session/llm"
import type { MessageV2 } from "@/session/message-v2"
import type { SessionID } from "@/session/schema"
import { Log } from "@/util/log"
import { Locale } from "./locale"
import type { WorkspaceRepo } from "./workspace-repo"

/** 대화 한 턴(마지막 요청과 그 답)을 읽어, 그 턴에 바뀐 파일을 설명하는 커밋 메시지를 짓는다. */
export namespace TurnSummary {
  const log = Log.create({ service: "turn-summary" })
  const MAX_FILES = 30
  const MAX_SUBJECT = 72

  const LABEL: Record<
    Locale.Value,
    Record<WorkspaceRepo.Change["status"], string> & { fallback: string; first: string; manual: string }
  > = {
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
  }

  export type Turn = { user: MessageV2.User; request: string; reply: string }

  export async function current(sessionID: SessionID) {
    const session = await Session.get(sessionID)
    if (session.parentID) return
    return latest(await Session.messages({ sessionID }))
  }

  export function latest(messages: MessageV2.WithParts[]): Turn | undefined {
    const text = (message: MessageV2.WithParts) =>
      message.parts
        .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text.trim()] : []))
        .filter(Boolean)
        .join("\n")
    const index = messages.findLastIndex((message) => message.info.role === "user" && text(message))
    const found = messages[index]
    if (!found || found.info.role !== "user") return
    const reply =
      messages
        .slice(index + 1)
        .filter((message) => message.info.role === "assistant")
        .map(text)
        .filter(Boolean)
        .at(-1) ?? ""
    return { user: found.info, request: text(found), reply }
  }

  export async function describe(turn: Turn, changes: WorkspaceRepo.Change[]) {
    const title = await summarize(turn).catch((err) => {
      log.error("summary failed", { error: err instanceof Error ? err.message : String(err) })
      return undefined
    })
    return compose(title || fallback(turn), changes, turn.user.locale)
  }

  /** 저장소를 만들자마자 올리는 첫 커밋의 제목. */
  export function first(locale?: Locale.Value) {
    return LABEL[locale ?? Locale.DEFAULT].first
  }

  /** 연결 화면에서 직접 올릴 때 커밋의 제목. */
  export function manual(locale?: Locale.Value) {
    return LABEL[locale ?? Locale.DEFAULT].manual
  }

  export function compose(subject: string, changes: WorkspaceRepo.Change[], locale?: Locale.Value) {
    const label = LABEL[locale ?? Locale.DEFAULT]
    const lines = changes.slice(0, MAX_FILES).map((change) => `- ${label[change.status]}: ${change.file}`)
    if (changes.length > MAX_FILES) lines.push(`- … +${changes.length - MAX_FILES}`)
    return [clip(subject), ...(lines.length ? ["", ...lines] : [])].join("\n")
  }

  function fallback(turn: Turn) {
    const line = turn.request
      .split("\n")
      .map((item) => item.trim())
      .find(Boolean)
    return line || LABEL[turn.user.locale ?? Locale.DEFAULT].fallback
  }

  function clip(text: string) {
    return text.length > MAX_SUBJECT ? text.slice(0, MAX_SUBJECT - 1) + "…" : text
  }

  async function summarize(turn: Turn) {
    const agent = await Agent.get("title")
    if (!agent) return
    const { providerID, modelID } = turn.user.model
    const model = agent.model
      ? await Provider.getModel(agent.model.providerID, agent.model.modelID)
      : ((await Provider.getSmallModel(providerID)) ?? (await Provider.getModel(providerID, modelID)))
    const content = [turn.request, turn.reply].filter(Boolean).join("\n\n").slice(0, 4000)
    const result = await LLM.stream({
      agent,
      user: turn.user,
      system: [],
      small: true,
      tools: {},
      model,
      sessionID: turn.user.sessionID,
      retries: 2,
      abort: AbortSignal.timeout(30_000),
      messages: [{ role: "user", content: `Generate a title for the change made in this conversation:\n\n${content}` }],
    })
    return (await result.text)
      .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean)
  }
}
