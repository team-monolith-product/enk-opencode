import { PostMessageManagerImpl } from "@team-monolith/post-message-manager"
import { onCleanup, onMount } from "solid-js"
import { decode64 } from "@/utils/base64"

type Part = { type?: string; text?: string; synthetic?: boolean; ignored?: boolean }
type Message = { info?: { role?: string; time?: { created?: number } }; parts?: Part[] }

export type LastTurn = { prompt: string; response: string; at: number | null }

export type Result = { status: "ok"; payload: LastTurn } | { status: "failed"; error: string }

const MESSAGE = "conversation.last-turn.request"
const TIMEOUT_MS = 15_000
const FETCH_LIMIT = 30
const MAX_PAGES = 5
export const PROMPT_MAX = 4000
export const RESPONSE_MAX = 6000

function texts(message: Message): string {
  return (message.parts ?? [])
    .filter((part) => part.type === "text" && !part.synthetic && !part.ignored && part.text?.trim())
    .map((part) => part.text!.trim())
    .join("\n\n")
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 마지막 참가자 발화와 그 뒤 AI 답(여러 스텝이면 이어 붙임)을 한 번의 대화로 묶는다. */
export function lastTurn(messages: Message[]): LastTurn | undefined {
  const index = messages.findLastIndex((message) => message.info?.role === "user" && texts(message))
  if (index < 0) return
  const response = messages
    .slice(index + 1)
    .filter((message) => message.info?.role === "assistant")
    .map(texts)
    .filter(Boolean)
    .join("\n\n")
  return {
    prompt: clip(texts(messages[index]), PROMPT_MAX),
    response: clip(response, RESPONSE_MAX),
    at: messages[index].info?.time?.created ?? null,
  }
}

export function currentSession(pathname: string): { directory?: string; sessionID: string } | undefined {
  const match = pathname.match(/\/([^/]+)\/session\/([^/?#]+)/)
  if (!match) return
  return { directory: decode64(match[1]), sessionID: match[2] }
}

export function LastTurnBridge() {
  onMount(() => {
    const pmm = new PostMessageManagerImpl(TIMEOUT_MS)
    pmm.register({
      messageType: MESSAGE,
      callback: async (): Promise<Result> => {
        const session = currentSession(window.location.pathname)
        if (!session) return { status: "failed", error: "no session" }
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
        try {
          // AI 가 스텝을 많이 밟았으면 마지막 발화가 첫 페이지 밖에 있어 앞 페이지를 더 읽는다.
          let messages: Message[] = []
          let before: string | null = null
          for (let page = 0; page < MAX_PAGES; page++) {
            const url = new URL(`session/${session.sessionID}/message`, document.baseURI)
            url.searchParams.set("limit", String(FETCH_LIMIT))
            if (before) url.searchParams.set("before", before)
            if (session.directory) url.searchParams.set("directory", session.directory)
            const res = await fetch(url, { signal: controller.signal })
            if (!res.ok) return { status: "failed", error: `HTTP ${res.status}` }
            messages = [...((await res.json()) as Message[]), ...messages]
            before = res.headers.get("X-Next-Cursor")
            if (lastTurn(messages) || !before) break
          }
          const turn = lastTurn(messages)
          if (!turn) return { status: "failed", error: "no turn" }
          return { status: "ok", payload: turn }
        } catch (e) {
          if (controller.signal.aborted) return { status: "failed", error: "timeout" }
          return { status: "failed", error: e instanceof Error ? e.message : String(e) }
        } finally {
          clearTimeout(timer)
        }
      },
    })
    onCleanup(() => pmm.unregister(MESSAGE))
  })
  return null
}
