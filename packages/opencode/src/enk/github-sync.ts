import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { Session } from "@/session"
import { LLM } from "@/session/llm"
import type { MessageV2 } from "@/session/message-v2"
import type { SessionID } from "@/session/schema"
import { Log } from "@/util/log"
import { GitHub } from "./github"
import { Locale } from "./locale"

export namespace GitHubSync {
  const log = Log.create({ service: "github-sync" })
  const MAX_FILES = 30
  const MAX_SUBJECT = 72

  const LABEL: Record<Locale.Value, Record<GitHub.Change["status"], string> & { fallback: string }> = {
    ko: { A: "추가", M: "수정", D: "삭제", fallback: "짓다에서 작업한 내용" },
    en: { A: "Add", M: "Update", D: "Delete", fallback: "Update from Jitda" },
  }

  export type Turn = { user: MessageV2.User; request: string; reply: string }

  export async function current(sessionID: SessionID) {
    const session = await Session.get(sessionID)
    if (session.parentID) return
    return latest(await Session.messages({ sessionID }))
  }

  export async function sync(dir: string, turn: Turn, message?: string) {
    await publish(dir, message ?? ((changes) => describe(turn, changes)))
  }

  export async function publish(dir: string, message: string | GitHub.Describe) {
    const status = await GitHub.status(dir)
    if (!status.login || !status.repo) return
    const result = await GitHub.push(dir, { message })
    if (result.sha) log.info("pushed", { sha: result.sha })
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

  export async function describe(turn: Turn, changes: GitHub.Change[]) {
    const title = await summarize(turn).catch((err) => {
      log.warn("summary failed", { error: err instanceof Error ? err.message : String(err) })
      return undefined
    })
    return compose(title || fallback(turn), changes, turn.user.locale)
  }

  export function compose(subject: string, changes: GitHub.Change[], locale?: Locale.Value) {
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
