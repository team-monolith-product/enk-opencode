import { apiUrl } from "@/utils/api-url"
import type { PromptApprovalInput } from "./submit"

export type DocSubmitActor = {
  actorID: string
  name: string
  color: string
  // "left" = dropped out mid-vote (shown as 나감). Blocks auto-send; the requester decides via the
  // "exclude" respond action whether to send without them. Flips back to "pending" on reconnect.
  status: "pending" | "approved" | "left"
}

export type DocSubmitState = {
  submitID: string
  sessionID: string
  // 'doc' → targetID is the prompt doc id; 'question' → the question request id; 'stop' → the prompt
  // doc id whose in-flight AI response a consensus would cancel; 'clear' → the prompt doc id of the
  // session a consensus would delete (archive).
  targetKind: "doc" | "question" | "stop" | "clear"
  targetID: string
  // For 'question' votes: whether the vote sends a reply, dismisses the question, or navigates back.
  questionAction?: "send" | "dismiss" | "back"
  actorID: string
  status: "pending" | "sent" | "cancelled" | "expired" | "left"
  actors: DocSubmitActor[]
  cancelledBy?: DocSubmitActor
  timeoutMs: number
  expiresAt: number
}

export type DocSubmitEvent = {
  type: "created" | "updated" | "sent" | "cancelled" | "expired" | "left"
  state: DocSubmitState
}

// Vote membership is decided server-side from the connected submit peers (and kept dynamic as
// participants join/leave), so create calls no longer pass an actorIDs snapshot — only display
// names for the members the server picks.
type StartInput = {
  baseUrl: string
  directory: string
  sessionID: string
  docID: string
  actorID: string
  names?: Record<string, string>
  prompt: Pick<PromptApprovalInput, "messageID" | "agent" | "model" | "variant" | "locale" | "parts">
  timeoutMs?: number
}

type RespondInput = {
  baseUrl: string
  directory: string
  sessionID: string
  submitID: string
  actorID: string
  action: "approve" | "cancel" | "exclude"
}

type SocketInput = {
  baseUrl: string
  directory: string
  sessionID: string
  docID: string
  actorID: string
  event: (event: DocSubmitEvent) => void
  // A readonly spectator connects observer-only: it receives every vote cast but the server keeps it
  // out of `peers`/targets() so it is never counted in consensus.
  observer?: boolean
}

const path = (input: { baseUrl: string; directory: string }, value: string) => {
  const url = apiUrl(input.baseUrl, value)
  url.searchParams.set("directory", input.directory)
  return url
}

// Server sends `{type:"ping"}` heartbeats so it can reap half-open sockets that never fire onClose.
// We answer immediately with a pong; a frozen/suspended tab simply stops answering and gets reaped.
const PONG = JSON.stringify({ type: "pong" })
const handlePing = (socket: WebSocket, data: string) => {
  if (!data.includes('"ping"')) return false
  if (socket.readyState === WebSocket.OPEN) socket.send(PONG)
  return true
}

const RETRY_MS = 500
// The mirror image of the server's reaper (Doc PING_INTERVAL 2s / PING_TIMEOUT 4.5s). A socket can
// die without ever firing `close` — a wifi handover, a NAT rebinding, a proxy dropping the tunnel —
// and the browser then reports OPEN for minutes while the server has already dropped us from the
// vote. That is exactly the device where "the consent dialog never appeared": it is not in `peers`
// any more, it receives no casts, and nothing ever makes it reconnect. Hearing nothing (not even a
// ping) for this long means the connection is gone, whatever readyState claims.
const SILENT_MS = 8_000
// On a wake-up (network back, tab visible again) don't sit out the silence window — but leave a
// socket that just heard something alone.
const FRESH_MS = 4_000

/**
 * A websocket that keeps itself alive: retries on close/error, and — unlike a plain reconnecting
 * socket — gives up on a connection that has gone quiet instead of trusting `readyState`.
 */
export function liveSocket(input: {
  url: URL
  onMessage: (data: string) => void
  /** Runs on every (re)connect once open: replay whatever the server must know about us. */
  onOpen?: (socket: WebSocket) => void
  /** How long silence means death. Overridable so tests don't have to sit out the real window. */
  silenceMs?: number
}) {
  const silenceMs = input.silenceMs ?? SILENT_MS
  let closed = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let silence: ReturnType<typeof setTimeout> | undefined
  let ws: WebSocket | undefined
  let lastSeen = Date.now()

  const clearSilence = () => {
    if (silence === undefined) return
    clearTimeout(silence)
    silence = undefined
  }

  const drop = () => {
    const dead = ws
    ws = undefined
    clearSilence()
    if (!dead) return
    // Detached before closing: a half-open socket can take seconds to fire `close`, or never fire it
    // at all, and the reconnect must not wait for that.
    if (dead.readyState !== WebSocket.CLOSED && dead.readyState !== WebSocket.CLOSING) dead.close()
  }

  const retry = (delay = RETRY_MS) => {
    if (closed || retryTimer) return
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      connect()
    }, delay)
  }

  const heard = () => {
    lastSeen = Date.now()
    clearSilence()
    silence = setTimeout(() => {
      drop()
      retry(0)
    }, silenceMs)
  }

  const connect = () => {
    if (closed) return
    const socket = new WebSocket(input.url)
    ws = socket
    // Armed from the attempt, not from the first message: a handshake that never completes is just
    // as dead as a silent socket.
    heard()
    socket.addEventListener("open", () => {
      if (ws !== socket) return
      heard()
      input.onOpen?.(socket)
    })
    socket.addEventListener("message", (event) => {
      if (ws !== socket || typeof event.data !== "string") return
      heard()
      if (handlePing(socket, event.data)) return
      input.onMessage(event.data)
    })
    socket.addEventListener("close", () => {
      if (ws !== socket) return
      ws = undefined
      clearSilence()
      retry()
    })
    socket.addEventListener("error", () => {
      if (ws !== socket) return
      drop()
      retry()
    })
  }

  const wake = () => {
    if (closed) return
    if (ws && Date.now() - lastSeen < FRESH_MS) return
    drop()
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
    retry(0)
  }
  const onVisible = () => {
    if (typeof document === "undefined" || document.visibilityState !== "visible") return
    wake()
  }
  if (typeof window !== "undefined") window.addEventListener("online", wake)
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible)

  connect()

  return {
    send: (data: string) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false
      ws.send(data)
      return true
    },
    close: () => {
      closed = true
      clearSilence()
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      retryTimer = undefined
      if (typeof window !== "undefined") window.removeEventListener("online", wake)
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible)
      const socket = ws
      ws = undefined
      if (socket && socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) socket.close(1000)
    },
  }
}

const json = async (url: URL, body: unknown) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await res.text())
  return (await res.json()) as DocSubmitState
}

export async function startSubmit(input: StartInput) {
  return json(path(input, `/session/${input.sessionID}/prompt-doc/submit`), {
    docID: input.docID,
    actorID: input.actorID,
    names: input.names,
    prompt: input.prompt,
    timeoutMs: input.timeoutMs,
  })
}

type StopInput = {
  baseUrl: string
  directory: string
  sessionID: string
  docID: string
  actorID: string
  names?: Record<string, string>
  timeoutMs?: number
}

// Start a consent vote to stop the session's in-flight AI response. Reuses the doc submit socket
// (keyed by docID) for lifecycle events and the same respond endpoint.
export async function startStopSubmit(input: StopInput) {
  return json(path(input, `/session/${input.sessionID}/prompt-doc/stop`), {
    docID: input.docID,
    actorID: input.actorID,
    names: input.names,
    timeoutMs: input.timeoutMs,
  })
}

// Start a consent vote to clear (delete) the session. Same socket and dialog as a stop vote; on
// approval the server cancels the run, archives the session and leaves a replacement behind.
export async function startClearSubmit(input: StopInput) {
  return json(path(input, `/session/${input.sessionID}/prompt-doc/clear`), {
    docID: input.docID,
    actorID: input.actorID,
    names: input.names,
    timeoutMs: input.timeoutMs,
  })
}

export async function respondSubmit(input: RespondInput) {
  return json(path(input, `/session/${input.sessionID}/prompt-doc/submit/${input.submitID}/respond`), {
    actorID: input.actorID,
    action: input.action,
  })
}

const state = (value: unknown): DocSubmitState | undefined => {
  if (!value || typeof value !== "object") return
  const item = value as { status?: unknown; submitID?: unknown; actors?: unknown }
  if (typeof item.submitID !== "string") return
  if (
    item.status !== "pending" &&
    item.status !== "sent" &&
    item.status !== "cancelled" &&
    item.status !== "expired" &&
    item.status !== "left"
  )
    return
  if (!Array.isArray(item.actors)) return
  return value as DocSubmitState
}

const parse = (data: string) => {
  try {
    const value = JSON.parse(data) as unknown
    if (!value || typeof value !== "object") return
    const type = (value as { type?: unknown }).type
    if (
      type !== "created" &&
      type !== "updated" &&
      type !== "sent" &&
      type !== "cancelled" &&
      type !== "expired" &&
      type !== "left"
    )
      return
    const next = state((value as { state?: unknown }).state)
    if (!next) return
    return { type, state: next } satisfies DocSubmitEvent
  } catch {
    return
  }
}

// ── Question reply consent (reuses the generalized consent machine, question endpoints) ──────────

export type QuestionSubmitPayload = { requestID: string; answers?: string[][]; reject?: boolean; step?: number }

type QuestionStartInput = {
  baseUrl: string
  directory: string
  sessionID: string
  requestID: string
  actorID: string
  names?: Record<string, string>
  payload: QuestionSubmitPayload
  timeoutMs?: number
}

export async function startQuestionSubmit(input: QuestionStartInput) {
  return json(path(input, `/session/${input.sessionID}/question/submit`), {
    requestID: input.requestID,
    actorID: input.actorID,
    names: input.names,
    payload: input.payload,
    timeoutMs: input.timeoutMs,
  })
}

export async function respondQuestionSubmit(input: RespondInput) {
  return json(path(input, `/session/${input.sessionID}/question/submit/${input.submitID}/respond`), {
    actorID: input.actorID,
    action: input.action,
  })
}

type QuestionSocketInput = {
  baseUrl: string
  directory: string
  sessionID: string
  requestID: string
  actorID: string
  event: (event: DocSubmitEvent) => void
  // See SocketInput.observer — readonly spectators watch the vote without joining it.
  observer?: boolean
}

// Self-healing websocket for question-reply consent lifecycle events (mirrors connectSubmit).
export function connectQuestionSubmit(input: QuestionSocketInput) {
  const url = path(input, `/session/${input.sessionID}/question/submit/connect`)
  url.searchParams.set("requestID", input.requestID)
  url.searchParams.set("actorID", input.actorID)
  if (input.observer) url.searchParams.set("observer", "true")
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"

  const socket = liveSocket({
    url,
    onMessage: (data) => {
      const next = parse(data)
      if (next) input.event(next)
    },
  })

  return socket.close
}

// ── Shared answer draft + presence (bidirectional channel) ───────────────────────────────────────

export type QuestionDraft = {
  requestID: string
  sessionID: string
  answers: string[][]
  custom: string[]
  customOn: boolean[]
  // Shared current question index — navigation is group-synced.
  step: number
  rev: number
}

export type QuestionDraftOp =
  | { kind: "single"; q: number; value: string | null }
  | { kind: "toggle"; q: number; label: string; on: boolean }
  | { kind: "custom"; q: number; text: string; on: boolean; multi: boolean }
  | { kind: "step"; value: number }

export type QuestionPresenceEntry = {
  actorID: string
  name: string
  color: string
  qIndex: number
  selection: string[]
  customFocused: boolean
}

type DraftSocketInput = {
  baseUrl: string
  directory: string
  sessionID: string
  requestID: string
  actorID: string
  onDraft: (draft: QuestionDraft) => void
  onPresence: (list: QuestionPresenceEntry[]) => void
}

export type QuestionDraftChannel = {
  sendOp: (op: QuestionDraftOp) => void
  sendPresence: (entry: QuestionPresenceEntry) => void
  close: () => void
}

const draftMessage = (
  data: string,
): { type: "draft"; draft: QuestionDraft } | { type: "presence"; presence: QuestionPresenceEntry[] } | undefined => {
  try {
    const value = JSON.parse(data) as { type?: unknown; draft?: unknown; presence?: unknown }
    if (value?.type === "draft" && value.draft && typeof value.draft === "object")
      return { type: "draft", draft: value.draft as QuestionDraft }
    if (value?.type === "presence" && Array.isArray(value.presence))
      return { type: "presence", presence: value.presence as QuestionPresenceEntry[] }
    return
  } catch {
    return
  }
}

export function connectQuestionDraft(input: DraftSocketInput): QuestionDraftChannel {
  const url = path(input, `/session/${input.sessionID}/question/draft/connect`)
  url.searchParams.set("requestID", input.requestID)
  url.searchParams.set("actorID", input.actorID)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"

  // Buffer outbound ops while (re)connecting so a click never gets dropped mid-handshake.
  let queue: string[] = []
  // Our latest presence, replayed on every (re)connect. A backgrounded tab that the browser froze
  // stops sending, so the server drops our presence past its grace; on resume the socket reconnects
  // and we must re-announce, otherwise our consensus selection stays invisible to peers until a fresh
  // click.
  let lastPresence: string | undefined

  const socket = liveSocket({
    url,
    onOpen: () => {
      if (lastPresence) socket.send(lastPresence)
      const pending = queue
      queue = []
      for (const data of pending) if (!socket.send(data)) queue.push(data)
    },
    onMessage: (data) => {
      const next = draftMessage(data)
      if (!next) return
      if (next.type === "draft") input.onDraft(next.draft)
      else input.onPresence(next.presence)
    },
  })

  const push = (msg: unknown) => {
    const data = JSON.stringify(msg)
    if (!socket.send(data)) queue.push(data)
  }

  return {
    sendOp: (op) => push({ type: "op", op }),
    sendPresence: (entry) => {
      // Remember it so onOpen can replay it after a reconnect; send now if we're already connected.
      lastPresence = JSON.stringify({ type: "presence", entry })
      socket.send(lastPresence)
    },
    close: socket.close,
  }
}

// ── Env value request draft ──────────────────────────────────────────────────────────────────
// 팀이 하나의 값 요청을 함께 채운다. 질문 초안과 전송 규약은 같지만 서버가 참여자만 받아주고
// (관전자 차단) 요청이 닫히면 초안을 지운다. 값은 이 소켓과 브라우저 메모리에만 존재한다.

export type EnvDraft = { requestID: string; sessionID: string; key: string; value: string; rev: number }

export type EnvDraftOp = { kind: "key"; text: string } | { kind: "value"; text: string }

export type EnvPresenceEntry = { actorID: string; name: string; color: string; editing: boolean }

export type EnvDraftChannel = {
  sendOp: (op: EnvDraftOp) => void
  sendPresence: (entry: EnvPresenceEntry) => void
  close: () => void
}

type EnvDraftSocketInput = {
  baseUrl: string
  directory: string
  sessionID: string
  requestID: string
  actorID: string
  /** AI 가 정한 환경변수 이름. 초안이 아직 없을 때 서버가 이 값으로 시작한다. */
  key: string
  onDraft: (draft: EnvDraft) => void
  onPresence: (list: EnvPresenceEntry[]) => void
}

const envDraftMessage = (
  data: string,
): { type: "draft"; draft: EnvDraft } | { type: "presence"; presence: EnvPresenceEntry[] } | undefined => {
  try {
    const value = JSON.parse(data) as { type?: unknown; draft?: unknown; presence?: unknown }
    if (value?.type === "draft" && value.draft && typeof value.draft === "object")
      return { type: "draft", draft: value.draft as EnvDraft }
    if (value?.type === "presence" && Array.isArray(value.presence))
      return { type: "presence", presence: value.presence as EnvPresenceEntry[] }
    return
  } catch {
    return
  }
}

export function connectEnvDraft(input: EnvDraftSocketInput): EnvDraftChannel {
  const url = path(input, `/session/${input.sessionID}/env-request/draft/connect`)
  url.searchParams.set("requestID", input.requestID)
  url.searchParams.set("actorID", input.actorID)
  url.searchParams.set("key", input.key)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"

  let queue: string[] = []
  let lastPresence: string | undefined

  const socket = liveSocket({
    url,
    onOpen: () => {
      if (lastPresence) socket.send(lastPresence)
      const pending = queue
      queue = []
      for (const data of pending) if (!socket.send(data)) queue.push(data)
    },
    onMessage: (data) => {
      const next = envDraftMessage(data)
      if (!next) return
      if (next.type === "draft") input.onDraft(next.draft)
      else input.onPresence(next.presence)
    },
  })

  const push = (msg: unknown) => {
    const data = JSON.stringify(msg)
    if (!socket.send(data)) queue.push(data)
  }

  return {
    sendOp: (op) => push({ type: "op", op }),
    sendPresence: (entry) => {
      lastPresence = JSON.stringify({ type: "presence", entry })
      socket.send(lastPresence)
    },
    close: socket.close,
  }
}

// This socket IS our membership in the consent vote (the server derives `peers` from it), so it has
// to notice its own death — see liveSocket.
export function connectSubmit(input: SocketInput) {
  const url = path(input, `/session/${input.sessionID}/prompt-doc/submit/connect`)
  url.searchParams.set("docID", input.docID)
  url.searchParams.set("actorID", input.actorID)
  if (input.observer) url.searchParams.set("observer", "true")
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"

  const socket = liveSocket({
    url,
    onMessage: (data) => {
      const next = parse(data)
      if (next) input.event(next)
    },
  })

  return socket.close
}
