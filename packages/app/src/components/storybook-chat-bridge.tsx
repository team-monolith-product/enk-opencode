import { PostMessageManagerImpl } from "@team-monolith/post-message-manager"
import { onCleanup, onMount } from "solid-js"

type Result = { status: "ok"; text?: string } | { status: "error"; message: string }
type ChatEvent = { kind: "started" | "tool" | "done" | "error"; detail?: string }

export const STORYBOOK_TOOLS = ["upsert_page", "delete_page", "generate_illustration"]

function currentSessionID(): string | undefined {
  const m = window.location.pathname.match(/\/session\/([^/?#]+)/)
  return m?.[1]
}

/** message.part.updated 버스 이벤트가 동화책 툴 실행 완료면 해당 툴 이름을 돌려준다. */
export function storybookToolEvent(data: unknown, sessionID?: string): string | undefined {
  if (typeof data !== "object" || data === null) return undefined
  const event = data as { type?: string; properties?: { part?: Record<string, unknown> } }
  if (event.type !== "message.part.updated") return undefined
  const part = event.properties?.part
  if (!part || part["type"] !== "tool") return undefined
  const tool = part["tool"]
  if (typeof tool !== "string" || !STORYBOOK_TOOLS.includes(tool)) return undefined
  if (sessionID && part["sessionID"] !== sessionID) return undefined
  const state = part["state"] as { status?: string } | undefined
  if (state?.status !== "completed") return undefined
  return tool
}

/** 어시스턴트 응답 parts 에서 사용자에게 보여줄 텍스트만 추린다(synthetic·ignored 제외). */
export function assistantText(parts: unknown): string | undefined {
  if (!Array.isArray(parts)) return undefined
  const text = parts
    .filter((p): p is { type: string; text: string; synthetic?: boolean; ignored?: boolean } => {
      if (typeof p !== "object" || p === null) return false
      const part = p as { type?: unknown; text?: unknown; synthetic?: unknown; ignored?: unknown }
      return part.type === "text" && typeof part.text === "string" && !part.synthetic && !part.ignored
    })
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join("\n\n")
  return text || undefined
}

export function assistantErrorDetail(info: unknown): string | undefined {
  if (typeof info !== "object" || info === null) return undefined
  const error = (info as { error?: { name?: string; data?: { message?: string } } }).error
  if (!error) return undefined
  return error.data?.message || error.name || "unknown error"
}

const TURN_TIMEOUT_MS = 10 * 60_000

export function StorybookChatBridge() {
  onMount(() => {
    const pmm = new PostMessageManagerImpl(TURN_TIMEOUT_MS)
    let events: EventSource | undefined

    const notify = (payload: ChatEvent) => {
      if (window.parent === window) return
      pmm.notify({ messageType: "storybook.chat.event", payload, target: window.parent, targetOrigin: "*" })
    }

    const listen = () => {
      if (events) return
      events = new EventSource(new URL("event", document.baseURI))
      events.onmessage = (e) => {
        try {
          const tool = storybookToolEvent(JSON.parse(e.data), currentSessionID())
          if (tool) notify({ kind: "tool", detail: tool })
        } catch {
          /* 이벤트 파싱 실패는 무시 */
        }
      }
    }

    pmm.register({
      messageType: "storybook.chat.request",
      callback: async (payload: { text?: string }): Promise<Result> => {
        const text = typeof payload?.text === "string" ? payload.text.trim() : ""
        if (!text) return { status: "error", message: "empty text" }
        const sid = currentSessionID()
        if (!sid) return { status: "error", message: "no session" }
        listen()
        notify({ kind: "started" })
        try {
          const res = await fetch(new URL(`session/${sid}/message`, document.baseURI), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parts: [{ type: "text", text }] }),
            signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
          })
          if (!res.ok) {
            notify({ kind: "error", detail: `HTTP ${res.status}` })
            return { status: "error", message: `HTTP ${res.status}` }
          }
          const message = (await res.json()) as { info?: unknown; parts?: unknown }
          const detail = assistantErrorDetail(message.info)
          if (detail) {
            notify({ kind: "error", detail })
            return { status: "error", message: detail }
          }
          notify({ kind: "done" })
          return { status: "ok", text: assistantText(message.parts) }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          notify({ kind: "error", detail: message })
          return { status: "error", message }
        }
      },
    })

    onCleanup(() => {
      pmm.unregister("storybook.chat.request")
      events?.close()
    })
  })
  return null
}
