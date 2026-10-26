import { randomBytes } from "node:crypto"
import * as Room from "./room"
import { Store } from "./store"
import { MSG_DOC, pack, unpack } from "./wire"

// 협업 프롬프트 문서와 합의 투표. 규칙은 V1 src/doc/index.ts 와 같다.
// 투표가 통과했을 때의 실제 동작(프롬프트 전송·중지·질문 응답·세션 보관)은 Host 가 V2 서버 API 로 한다.

export type SubmitTargetKind = "doc" | "question" | "stop" | "clear" | "revert"
export type SubmitStatus = "pending" | "sent" | "cancelled" | "expired" | "left"
// "left" 는 예전 규칙으로 저장된 행을 읽기 위해서만 남긴다. 지금은 나가면 모든 대기 투표에서 표와 함께 빠진다.
export type SubmitActorStatus = "pending" | "approved" | "left"
export type SubmitEventType = "created" | "updated" | "sent" | "cancelled" | "expired" | "left"
export type RespondAction = "approve" | "cancel"

export type SubmitActorInfo = { actorID: string; name: string; color: string; status: SubmitActorStatus }

export type SubmitState = {
  submitID: string
  sessionID: string
  targetKind: SubmitTargetKind
  targetID: string
  questionAction?: "send" | "dismiss" | "back"
  revertAction?: "revert" | "redo"
  actorID: string
  status: SubmitStatus
  actors: SubmitActorInfo[]
  cancelledBy?: SubmitActorInfo
  timeoutMs: number
  expiresAt: number
}

export type SubmitEvent = { type: SubmitEventType; state: SubmitState }

export type QuestionPayload = {
  requestID: string
  answers?: string[][]
  reject?: boolean
  step?: number
}

export type RevertPayload = { messageID: string } | { redo: true }

export type ActorInfo = { actorID: string; sessionID: string; userID?: string; name: string; color: string }

export type Host = {
  prompt: (sessionID: string, body: Record<string, unknown>) => Promise<{ messageID?: string } | undefined>
  interrupt: (sessionID: string) => Promise<unknown>
  formReply: (sessionID: string, formID: string, answers: string[][]) => Promise<unknown>
  formCancel: (sessionID: string, formID: string) => Promise<unknown>
  archive: (sessionID: string) => Promise<unknown>
  revert: (sessionID: string, messageID: string) => Promise<unknown>
  unrevert: (sessionID: string) => Promise<unknown>
  emit: (event: { type: string; properties: Record<string, unknown> }) => void
}

const idle = () => Promise.resolve(undefined)
let host: Host = {
  prompt: idle,
  interrupt: idle,
  formReply: idle,
  formCancel: idle,
  archive: idle,
  revert: idle,
  unrevert: idle,
  emit: () => {},
}

export function setHost(next: Host) {
  host = next
}

export class NotFoundError extends Error {
  readonly status = 404
  override readonly name = "NotFoundError"
}

export class VoteConflictError extends Error {
  readonly status = 400
  override readonly name = "DocVoteConflictError"
}

export class InvalidError extends Error {
  readonly status = 400
  override readonly name = "BadRequestError"
}

const COLORS = [
  "#e03131",
  "#c2255c",
  "#9c36b5",
  "#6741d9",
  "#3b5bdb",
  "#1971c2",
  "#0c8599",
  "#099268",
  "#2f9e44",
  "#66a80f",
  "#f08c00",
  "#e8590c",
]
const COLOR_WINDOW = 60 * 60 * 1000

export const DEFAULT = 30_000
export const MIN = 10_000
export const MAX = 600_000
export const EXTEND = 3_000
export const MAX_EXTEND = 30_000
const MAX_NAME = 64
export const REPLAY_WINDOW = 15_000
export const LEAVE_GRACE = 2_000
// 투표에서 빠지기 전 유예. 숨은 탭은 재접속 타이머가 1초 이상 밀리므로 초안·현재 위치(LEAVE_GRACE)보다 넉넉히 둔다.
export const VOTE_LEAVE_GRACE = 10_000
export const PING_INTERVAL = 2_000
export const PING_TIMEOUT = 4_500

const db = () => Store.db()

type DocRow = { id: string; kind: string; time_created: number; time_updated: number }
type ActorRow = {
  session_id: string
  actor_id: string
  user_id: string | null
  name: string
  color: string
  time_created: number
  time_seen: number
}
type SubmitRow = {
  id: string
  session_id: string
  target_kind: string
  target_id: string
  doc_id: string | null
  actor_id: string
  status: string
  prompt: string
  timeout_ms: number
  expires_at: number
  cancelled_by: string | null
  user_message_id: string | null
  time_created: number
  time_updated: number
}
type SubmitActorRow = {
  submit_id: string
  actor_id: string
  name: string
  status: string
  time_responded: number | null
}

function color(id: string) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return COLORS[Math.abs(h) % COLORS.length]!
}

const hex = (value?: string): value is string => !!value && /^#[0-9a-fA-F]{6}$/.test(value)

function actors(sessionID: string) {
  return db().query<ActorRow, [string]>("SELECT * FROM session_actor WHERE session_id = ?").all(sessionID)
}

function pickColor(sessionID: string, self: string, current?: string, preferred?: string) {
  if (hex(preferred)) return preferred
  const now = Date.now()
  const used = new Set(
    actors(sessionID)
      .filter((row) => row.actor_id !== self && now - row.time_seen < COLOR_WINDOW)
      .map((row) => row.color),
  )
  if (current && !used.has(current)) return current
  return COLORS.find((item) => !used.has(item)) ?? current ?? color(self)
}

function fallback(id: string) {
  return `Guest-${id.slice(-4)}`
}

function cap(name: string) {
  return name.trim().slice(0, MAX_NAME)
}

function toBytes(raw: unknown) {
  if (raw instanceof Uint8Array) return new Uint8Array(raw)
  return new Uint8Array(Buffer.from(raw as Buffer))
}

function loadUpdates(id: string) {
  if (Room.loaded(id)) return
  const rows = db()
    .query<{ data: Uint8Array }, [string]>("SELECT data FROM doc_update WHERE doc_id = ? ORDER BY time_created, id")
    .all(id)
  if (rows.length === 0) return
  for (const row of rows) {
    const data = toBytes(row.data)
    const msg = unpack(data)
    if (msg?.type === MSG_DOC) {
      Room.apply(id, msg.guid, msg.data)
      continue
    }
    Room.apply(id, id, data)
  }
}

export function get(id: string) {
  const row = db().query<DocRow, [string]>("SELECT * FROM doc WHERE id = ?").get(id)
  if (!row) throw new NotFoundError("Doc not found")
  loadUpdates(id)
  return row
}

function insertDoc(id: string) {
  const now = Date.now()
  db().run("INSERT INTO doc (id, kind, time_created, time_updated) VALUES (?, 'prompt', ?, ?)", [id, now, now])
}

export function prompt(sessionID: string) {
  const existing = db()
    .query<{ doc_id: string }, [string]>("SELECT doc_id FROM session_prompt_doc WHERE session_id = ?")
    .get(sessionID)
  if (existing) {
    loadUpdates(existing.doc_id)
    return { docID: existing.doc_id, sessionID }
  }
  const docID = Store.ascending("doc")
  db().transaction(() => {
    insertDoc(docID)
    db().run("INSERT INTO session_prompt_doc (session_id, doc_id) VALUES (?, ?)", [sessionID, docID])
  })()
  return { docID, sessionID }
}

export function promptAdvance(input: { sessionID: string; clientID?: string }) {
  const docID = Store.ascending("doc")
  insertDoc(docID)
  return { docID, sessionID: input.sessionID }
}

export function promptReady(input: { sessionID: string; docID: string; clientID?: string; init?: boolean }) {
  get(input.docID)
  db().run(
    "INSERT INTO session_prompt_doc (session_id, doc_id) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET doc_id = excluded.doc_id",
    [input.sessionID, input.docID],
  )
  host.emit({
    type: "doc.prompt.rotated",
    properties: {
      sessionID: input.sessionID,
      docID: input.docID,
      ...(input.clientID === undefined ? {} : { clientID: input.clientID }),
      ...(input.init === undefined ? {} : { init: input.init }),
    },
  })
  return { docID: input.docID, sessionID: input.sessionID }
}

export function syncPull(input: { docID: string; guid: string; state: Uint8Array }) {
  get(input.docID)
  return Room.pull(input.docID, input.guid, input.state)
}

let updateSeq = 0

export function syncPush(input: { docID: string; guid: string; data: Uint8Array; peer?: Room.Peer }) {
  get(input.docID)
  Room.push(input.docID, input.guid, input.data, input.peer)
  updateSeq = (updateSeq + 1) % 1_000_000
  const id = `${Date.now().toString(36).padStart(9, "0")}${updateSeq.toString(36).padStart(4, "0")}${randomBytes(6).toString("hex")}`
  db().run("INSERT INTO doc_update (id, doc_id, data, time_created) VALUES (?, ?, ?, ?)", [
    id,
    input.docID,
    pack(MSG_DOC, input.guid, input.data),
    Date.now(),
  ])
}

export function assetCreate(input: { docID: string; assetID?: string; mime: string; data: Uint8Array }) {
  get(input.docID)
  const assetID = input.assetID ?? Store.ascending("ast")
  const now = Date.now()
  db().run(
    `INSERT INTO doc_asset (id, doc_id, mime, data, size, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(doc_id, id) DO UPDATE SET mime = excluded.mime, data = excluded.data, size = excluded.size, time_updated = excluded.time_updated`,
    [assetID, input.docID, input.mime, input.data, input.data.byteLength, now, now],
  )
  return {
    assetID,
    docID: input.docID,
    mime: input.mime,
    size: input.data.byteLength,
    url: `/doc/${input.docID}/asset/${assetID}`,
  }
}

export function assetGet(input: { docID: string; assetID: string }) {
  get(input.docID)
  const row = db()
    .query<
      { id: string; doc_id: string; mime: string; data: Uint8Array; size: number },
      [string, string]
    >("SELECT id, doc_id, mime, data, size FROM doc_asset WHERE doc_id = ? AND id = ?")
    .get(input.docID, input.assetID)
  if (!row) throw new NotFoundError("Doc asset not found")
  return { assetID: row.id, docID: row.doc_id, mime: row.mime, data: toBytes(row.data), size: row.size }
}

type SubmitPeer = { actorID: string; send: (data: string) => void; close?: () => void; lastSeen: number }
type LivePeer = { send: (data: string) => void; close?: () => void; lastSeen: number }
type DraftPeer = SubmitPeer

const peers = new Map<string, Set<SubmitPeer>>()
const observers = new Map<string, Set<LivePeer>>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
// targetID → (actorID → 연결이 끊긴 시각). 유예가 지난 사람들을 한 번에 빼고 한 번만 판단한다.
const offline = new Map<string, Map<string, number>>()
const leaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
let heartbeat: ReturnType<typeof setInterval> | undefined
const ping = JSON.stringify({ type: "ping" })

function sweep() {
  const now = Date.now()
  const reap = (set: Set<LivePeer>) => {
    for (const peer of set) {
      if (now - peer.lastSeen > PING_TIMEOUT) {
        peer.close?.()
        continue
      }
      peer.send(ping)
    }
  }
  for (const set of peers.values()) reap(set)
  for (const set of draftPeers.values()) reap(set)
  for (const set of envDraftPeers.values()) reap(set)
  for (const set of observers.values()) reap(set)
}

function heartbeatStart() {
  if (heartbeat) return
  heartbeat = setInterval(sweep, PING_INTERVAL)
  heartbeat.unref?.()
}

function heartbeatStop() {
  if (!heartbeat) return
  if (peers.size > 0 || draftPeers.size > 0 || envDraftPeers.size > 0 || observers.size > 0) return
  clearInterval(heartbeat)
  heartbeat = undefined
}

export function heartbeatSweep() {
  sweep()
}

function clamp(input?: number) {
  if (input === undefined) return DEFAULT
  return Math.min(MAX, Math.max(MIN, input))
}

function parseJSON(text: string) {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function questionPayload(text: string): QuestionPayload | undefined {
  const value = parseJSON(text)
  if (!value || typeof value !== "object") return
  const payload = value as QuestionPayload
  if (typeof payload.requestID !== "string") return
  return payload
}

function revertPayload(text: string): RevertPayload | undefined {
  const value = parseJSON(text)
  if (!value || typeof value !== "object") return
  const payload = value as { messageID?: unknown; redo?: unknown }
  if (payload.redo === true) return { redo: true }
  if (typeof payload.messageID === "string" && payload.messageID) return { messageID: payload.messageID }
  return
}

function submitRow(id: string) {
  return db().query<SubmitRow, [string]>("SELECT * FROM doc_submit WHERE id = ?").get(id) ?? undefined
}

function updateSubmit(id: string, set: Partial<SubmitRow>) {
  const keys = Object.keys(set) as (keyof SubmitRow)[]
  if (keys.length === 0) return submitRow(id)
  const assignments = keys.map((key) => `${key} = ?`).join(", ")
  return (
    db()
      .query<SubmitRow, (string | number | null)[]>(`UPDATE doc_submit SET ${assignments} WHERE id = ? RETURNING *`)
      .get(...keys.map((key) => set[key] as string | number | null), id) ?? undefined
  )
}

function read(row: SubmitRow): SubmitState {
  const colors = new Map(actors(row.session_id).map((actor) => [actor.actor_id, actor.color]))
  const list = db()
    .query<SubmitActorRow, [string]>("SELECT * FROM doc_submit_actor WHERE submit_id = ? ORDER BY rowid")
    .all(row.id)
    .map((item) => ({
      actorID: item.actor_id,
      name: item.name,
      color: colors.get(item.actor_id) ?? color(item.actor_id),
      status: item.status as SubmitActorStatus,
    }))
  const questionAction = (() => {
    if (row.target_kind !== "question") return undefined
    const payload = questionPayload(row.prompt)
    if (payload?.step !== undefined) return "back" as const
    return payload?.reject ? ("dismiss" as const) : ("send" as const)
  })()
  const revertAction = (() => {
    if (row.target_kind !== "revert") return undefined
    const payload = revertPayload(row.prompt)
    if (!payload) return undefined
    return "redo" in payload ? ("redo" as const) : ("revert" as const)
  })()
  return {
    submitID: row.id,
    sessionID: row.session_id,
    targetKind: row.target_kind as SubmitTargetKind,
    targetID: row.target_id,
    ...(questionAction ? { questionAction } : {}),
    ...(revertAction ? { revertAction } : {}),
    actorID: row.actor_id,
    status: row.status as SubmitStatus,
    actors: list,
    ...(row.cancelled_by ? { cancelledBy: list.find((item) => item.actorID === row.cancelled_by) } : {}),
    timeoutMs: row.timeout_ms,
    expiresAt: row.expires_at,
  }
}

function cast(type: SubmitEventType, state: SubmitState) {
  const data = JSON.stringify({ type, state } satisfies SubmitEvent)
  const set = peers.get(state.targetID)
  if (set) {
    const ids = new Set(state.actors.map((actor) => actor.actorID))
    set.forEach((peer) => {
      if (ids.has(peer.actorID)) peer.send(data)
    })
  }
  observers.get(state.targetID)?.forEach((peer) => peer.send(data))
}

function done(id: string) {
  const timer = timers.get(id)
  if (!timer) return
  clearTimeout(timer)
  timers.delete(id)
}

function fail(row: SubmitRow, err: unknown) {
  host.emit({
    type: "doc.error",
    properties: {
      sessionID: row.session_id,
      error: { name: "UnknownError", data: { message: err instanceof Error ? err.message : String(err) } },
    },
  })
}

function rotate(row: SubmitRow) {
  const next = promptAdvance({ sessionID: row.session_id })
  promptReady({ sessionID: row.session_id, docID: next.docID, init: true })
}

function send(row: SubmitRow) {
  if (row.target_kind === "clear") {
    host.archive(row.session_id).catch((err) => fail(row, err))
    return
  }
  if (row.target_kind === "revert") {
    const payload = revertPayload(row.prompt)
    if (!payload) return
    const run = "redo" in payload ? host.unrevert(row.session_id) : host.revert(row.session_id, payload.messageID)
    run.catch((err) => fail(row, err))
    return
  }
  if (row.target_kind === "stop") {
    host.interrupt(row.session_id).catch((err) => fail(row, err))
    return
  }
  if (row.target_kind === "question") {
    const payload = questionPayload(row.prompt)
    if (!payload) return
    if (payload.step !== undefined) {
      questionDraftApply({
        sessionID: row.session_id,
        requestID: payload.requestID,
        op: { kind: "step", value: payload.step },
      })
      return
    }
    const run = payload.reject
      ? host.formCancel(row.session_id, payload.requestID)
      : host.formReply(row.session_id, payload.requestID, payload.answers ?? [])
    run.catch((err) => fail(row, err))
    questionDraftReset(payload.requestID)
    return
  }
  const body = (parseJSON(row.prompt) ?? {}) as Record<string, unknown>
  const metadata = (body.metadata && typeof body.metadata === "object" ? body.metadata : {}) as Record<string, unknown>
  host
    .prompt(row.session_id, {
      ...body,
      metadata: { ...metadata, jitda: { docID: row.doc_id, submitID: row.id, actorID: row.actor_id } },
    })
    .then((result) => {
      rotate(row)
      if (result?.messageID) updateSubmit(row.id, { user_message_id: result.messageID })
    })
    .catch((err) => fail(row, err))
}

function expire(row: SubmitRow, now = Date.now()) {
  if (row.status !== "pending") return row
  if (row.expires_at > now) return row
  const next = updateSubmit(row.id, { status: "expired", time_updated: now })
  done(row.id)
  if (!next) return row
  cast("expired", read(next))
  return next
}

function pendingRows(sessionID: string, targetID?: string, targetKind?: SubmitTargetKind) {
  const filters = ["session_id = ?", "status = 'pending'"]
  const args: string[] = [sessionID]
  if (targetID !== undefined) {
    filters.push("target_id = ?")
    args.push(targetID)
  }
  if (targetKind !== undefined) {
    filters.push("target_kind = ?")
    args.push(targetKind)
  }
  return db()
    .query<SubmitRow, string[]>(`SELECT * FROM doc_submit WHERE ${filters.join(" AND ")} ORDER BY id`)
    .all(...args)
}

function pending(sessionID: string) {
  for (const row of pendingRows(sessionID)) {
    const next = expire(row)
    if (next.status !== "pending") continue
    if (!timers.has(next.id)) schedule(next)
    return next
  }
  return undefined
}

function active(sessionID: string, targetID: string, actorID?: string, targetKind?: SubmitTargetKind) {
  return pendingRows(sessionID, targetID, targetKind)
    .map((row) => {
      const next = expire(row)
      if (next.status === "pending" && !timers.has(next.id)) schedule(next)
      return read(next)
    })
    .find((item) => item.status === "pending" && (!actorID || item.actors.some((actor) => actor.actorID === actorID)))
}

function recent(sessionID: string, targetID: string, actorID: string, now = Date.now()) {
  const rows = db()
    .query<
      SubmitRow,
      [string, string]
    >("SELECT * FROM doc_submit WHERE session_id = ? AND target_id = ? ORDER BY time_updated DESC")
    .all(sessionID, targetID)
  for (const row of rows) {
    if (row.status === "pending") continue
    if (row.time_updated < now - REPLAY_WINDOW) return
    const state = read(row)
    if (state.actors.some((actor) => actor.actorID === actorID)) return state
  }
  return
}

function extend(row: SubmitRow, now = Date.now()) {
  if (row.status !== "pending") return row
  const limit = row.time_created + row.timeout_ms + MAX_EXTEND
  const deadline = Math.min(row.expires_at + EXTEND, now + row.timeout_ms, limit)
  if (deadline <= row.expires_at) return row
  const next = updateSubmit(row.id, { expires_at: deadline, time_updated: now })
  if (!next) return row
  schedule(next)
  return next
}

function schedule(row: SubmitRow) {
  done(row.id)
  if (row.status !== "pending") return
  const wait = row.expires_at - Date.now()
  if (wait <= 0) {
    expire(row)
    return
  }
  const timer = setTimeout(() => {
    timers.delete(row.id)
    const next = submitRow(row.id)
    if (next) expire(next)
  }, wait)
  timer.unref?.()
  timers.set(row.id, timer)
}

export function recover() {
  const rows = db().query<SubmitRow, []>("SELECT * FROM doc_submit WHERE status = 'pending'").all()
  for (const row of rows) {
    const next = expire(row)
    if (next.status !== "pending") continue
    schedule(next)
    // 재시작 뒤 다시 접속하지 않은 참여자는 퇴장과 같다. 유예 시간 안에 돌아오면 그대로 남는다.
    const now = Date.now()
    for (const actor of read(next).actors) scheduleLeave(next.target_id, actor.actorID, now)
  }
}

function actorNames(sessionID: string, ids: string[], names?: Record<string, string>) {
  const list = actors(sessionID)
  return ids.map((id) => {
    const provided = names?.[id] ? cap(names[id]!) : ""
    if (provided) return { actorID: id, name: provided }
    return { actorID: id, name: list.find((actor) => actor.actor_id === id)?.name ?? fallback(id) }
  })
}

function targets(targetID: string, actorID: string) {
  const result = new Set(Array.from(peers.get(targetID) ?? []).map((peer) => peer.actorID))
  result.add(actorID)
  return Array.from(result)
}

function create(input: {
  sessionID: string
  targetKind: SubmitTargetKind
  targetID: string
  docID: string | null
  actorID: string
  names?: Record<string, string>
  promptBlob: string
  timeoutMs?: number
}) {
  const found = active(input.sessionID, input.targetID, undefined, input.targetKind)
  if (found) return found

  const busy = pending(input.sessionID)
  const exclusive = (kind: string) => kind === "clear" || kind === "revert"
  if (busy && (exclusive(input.targetKind) || exclusive(busy.target_kind)))
    throw new VoteConflictError("Another consent vote is in progress")

  const ids = targets(input.targetID, input.actorID)
  const timeout = clamp(input.timeoutMs)
  const now = Date.now()
  const build = () =>
    db().transaction(() => {
      const id = Store.ascending("sub")
      db().run(
        `INSERT INTO doc_submit (id, session_id, target_kind, target_id, doc_id, actor_id, status, prompt, timeout_ms, expires_at, cancelled_by, user_message_id, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
        [
          id,
          input.sessionID,
          input.targetKind,
          input.targetID,
          input.docID,
          input.actorID,
          ids.length <= 1 ? "sent" : "pending",
          input.promptBlob,
          timeout,
          now + timeout,
          now,
          now,
        ],
      )
      for (const actor of actorNames(input.sessionID, ids, input.names)) {
        const self = actor.actorID === input.actorID
        db().run(
          "INSERT INTO doc_submit_actor (submit_id, actor_id, name, status, time_responded) VALUES (?, ?, ?, ?, ?)",
          [id, actor.actorID, actor.name, self ? "approved" : "pending", self ? now : null],
        )
      }
      return submitRow(id)!
    })()

  let row: SubmitRow
  try {
    row = build()
  } catch (err) {
    const winner = active(input.sessionID, input.targetID, undefined, input.targetKind)
    if (winner) return winner
    throw err
  }

  const state = read(row)
  if (state.status === "sent") {
    cast("sent", state)
    send(row)
    return state
  }
  schedule(row)
  cast("created", state)
  return state
}

export type SubmitCreateInput = {
  sessionID: string
  docID: string
  actorID: string
  actorIDs?: string[]
  names?: Record<string, string>
  prompt: Record<string, unknown>
  timeoutMs?: number
}

export function submitCreate(input: SubmitCreateInput) {
  get(input.docID)
  return create({
    sessionID: input.sessionID,
    targetKind: "doc",
    targetID: input.docID,
    docID: input.docID,
    actorID: input.actorID,
    names: input.names,
    promptBlob: JSON.stringify(input.prompt),
    timeoutMs: input.timeoutMs,
  })
}

export type ControlSubmitCreateInput = {
  sessionID: string
  docID: string
  actorID: string
  actorIDs?: string[]
  names?: Record<string, string>
  timeoutMs?: number
}

export function stopSubmitCreate(input: ControlSubmitCreateInput) {
  get(input.docID)
  return create({
    sessionID: input.sessionID,
    targetKind: "stop",
    targetID: input.docID,
    docID: input.docID,
    actorID: input.actorID,
    names: input.names,
    promptBlob: "{}",
    timeoutMs: input.timeoutMs,
  })
}

export function clearSubmitCreate(input: ControlSubmitCreateInput) {
  get(input.docID)
  return create({
    sessionID: input.sessionID,
    targetKind: "clear",
    targetID: input.docID,
    docID: input.docID,
    actorID: input.actorID,
    names: input.names,
    promptBlob: "{}",
    timeoutMs: input.timeoutMs,
  })
}

export function revertSubmitCreate(input: ControlSubmitCreateInput & { messageID?: string; redo?: boolean }) {
  get(input.docID)
  const payload: RevertPayload | undefined = input.redo
    ? { redo: true }
    : input.messageID
      ? { messageID: input.messageID }
      : undefined
  if (!payload) throw new InvalidError("Revert needs a messageID or redo")
  return create({
    sessionID: input.sessionID,
    targetKind: "revert",
    targetID: input.docID,
    docID: input.docID,
    actorID: input.actorID,
    names: input.names,
    promptBlob: JSON.stringify(payload),
    timeoutMs: input.timeoutMs,
  })
}

export type QuestionSubmitCreateInput = {
  sessionID: string
  requestID: string
  actorID: string
  actorIDs?: string[]
  names?: Record<string, string>
  payload: QuestionPayload
  timeoutMs?: number
}

export function questionSubmitCreate(input: QuestionSubmitCreateInput) {
  return create({
    sessionID: input.sessionID,
    targetKind: "question",
    targetID: input.requestID,
    docID: null,
    actorID: input.actorID,
    names: input.names,
    promptBlob: JSON.stringify(input.payload),
    timeoutMs: input.timeoutMs,
  })
}

function submitActor(submitID: string, actorID: string) {
  return (
    db()
      .query<SubmitActorRow, [string, string]>("SELECT * FROM doc_submit_actor WHERE submit_id = ? AND actor_id = ?")
      .get(submitID, actorID) ?? undefined
  )
}

export function submitRespond(input: { sessionID: string; submitID: string; actorID: string; action: RespondAction }) {
  const row = db()
    .query<SubmitRow, [string, string]>("SELECT * FROM doc_submit WHERE session_id = ? AND id = ?")
    .get(input.sessionID, input.submitID)
  if (!row) throw new NotFoundError("Doc submit not found")
  const next = expire(row)
  if (next.status !== "pending") return read(next)

  const actor = submitActor(input.submitID, input.actorID)
  if (!actor) throw new NotFoundError("Doc submit actor not found")

  if (input.action === "cancel") {
    const item = updateSubmit(input.submitID, {
      status: "cancelled",
      cancelled_by: input.actorID,
      time_updated: Date.now(),
    })
    if (!item) throw new NotFoundError("Doc submit not found")
    done(input.submitID)
    const state = read(item)
    cast("cancelled", state)
    return state
  }

  if (actor.status !== "approved")
    db().run(
      "UPDATE doc_submit_actor SET status = 'approved', time_responded = ? WHERE submit_id = ? AND actor_id = ?",
      [Date.now(), input.submitID, input.actorID],
    )

  const state = read(next)
  if (!agreed(state)) {
    cast("updated", state)
    return state
  }

  const finished = finalize(next)
  if (!finished) throw new NotFoundError("Doc submit not found")
  return finished
}

// 남은 참여 인원 전원이 동의했는지. 0명은 동의가 아니다.
function agreed(state: SubmitState) {
  return state.actors.length > 0 && state.actors.every((item) => item.status === "approved")
}

function finalize(row: SubmitRow) {
  const sent = updateSubmit(row.id, { status: "sent", time_updated: Date.now() })
  if (!sent) return
  done(row.id)
  const finished = read(sent)
  cast("sent", finished)
  send(sent)
  return finished
}

function online(targetID: string, actorID: string) {
  const set = peers.get(targetID)
  return set ? Array.from(set).some((item) => item.actorID === actorID) : false
}

// 남은 전원이 동의했고 지금 모두 접속해 있을 때만 보낸다. 끊긴 채 유예 중인 사람의 표로는 보내지 않는다.
function evaluate(row: SubmitRow) {
  const state = read(row)
  if (agreed(state) && state.actors.every((item) => online(row.target_id, item.actorID))) return finalize(row)
  return state
}

// 참여 인원 기준 판단, 퇴장 쪽: 나간 사람들은 결론 나지 않은 모든 투표에서 표와 함께 빠지고, 남은 인원으로
// 한 번만 다시 판단한다. 요청자도 예외가 아니다. 아무도 남지 않으면 보내지 않는다.
function leave(targetID: string, actorIDs: string[]) {
  const rows = db()
    .query<SubmitRow, [string]>("SELECT * FROM doc_submit WHERE target_id = ? AND status = 'pending'")
    .all(targetID)
  for (const row of rows) {
    const next = expire(row)
    if (next.status !== "pending") continue
    const gone = read(next).actors.filter((item) => actorIDs.includes(item.actorID))
    if (gone.length === 0) continue
    db().run(`DELETE FROM doc_submit_actor WHERE submit_id = ? AND actor_id IN (${gone.map(() => "?").join(", ")})`, [
      next.id,
      ...gone.map((item) => item.actorID),
    ])
    const state = evaluate(next)
    if (state?.status === "pending") cast("updated", state)
  }
}

function join(sessionID: string, targetID: string, actorID: string) {
  let first: SubmitState | undefined
  for (const row of pendingRows(sessionID, targetID)) {
    const next = expire(row)
    if (next.status !== "pending") continue
    if (!timers.has(next.id)) schedule(next)
    let state = read(next)
    const existing = state.actors.find((actor) => actor.actorID === actorID)
    if (existing?.status === "left") {
      // 예전 규칙으로 "나감" 표시가 남은 사람이 돌아오면 다시 대기로 묻는다.
      db().run(
        "UPDATE doc_submit_actor SET status = 'pending', time_responded = NULL WHERE submit_id = ? AND actor_id = ?",
        [next.id, actorID],
      )
      state = read(extend(next))
      cast("updated", state)
    }
    if (!existing) {
      db().run(
        "INSERT OR IGNORE INTO doc_submit_actor (submit_id, actor_id, name, status, time_responded) VALUES (?, ?, ?, 'pending', NULL)",
        [next.id, actorID, actorNames(sessionID, [actorID])[0]!.name],
      )
      state = read(extend(next))
      cast("updated", state)
    }
    if (existing?.status === "approved") {
      // 동의한 채 잠깐 끊겼던 사람이 돌아와 남은 전원이 접속·동의 상태가 되면 그때 보낸다.
      const after = evaluate(next)
      if (after?.status !== "pending") continue
    }
    first ??= state
  }
  return first
}

function cancelLeave(targetID: string, actorID: string) {
  const map = offline.get(targetID)
  if (!map?.delete(actorID)) return
  if (map.size === 0) offline.delete(targetID)
  arm(targetID)
}

function scheduleLeave(targetID: string, actorID: string, since = Date.now()) {
  const map = offline.get(targetID) ?? new Map<string, number>()
  if (!map.has(actorID)) map.set(actorID, since)
  offline.set(targetID, map)
  arm(targetID)
}

// 대상마다 타이머 하나: 가장 먼저 유예가 끝나는 사람에 맞춘다.
function arm(targetID: string) {
  const timer = leaveTimers.get(targetID)
  if (timer) clearTimeout(timer)
  leaveTimers.delete(targetID)
  const map = offline.get(targetID)
  if (!map) return
  const first = Math.min(...map.values())
  const next = setTimeout(
    () => {
      leaveTimers.delete(targetID)
      settleLeaves(targetID)
    },
    Math.max(0, first + VOTE_LEAVE_GRACE - Date.now()),
  )
  next.unref?.()
  leaveTimers.set(targetID, next)
}

function settleLeaves(targetID: string, now = Date.now()) {
  const map = offline.get(targetID)
  if (!map) return
  const gone: string[] = []
  for (const [actorID, since] of map) {
    if (online(targetID, actorID)) {
      map.delete(actorID)
      continue
    }
    if (since + VOTE_LEAVE_GRACE > now) continue
    map.delete(actorID)
    gone.push(actorID)
  }
  if (map.size === 0) offline.delete(targetID)
  arm(targetID)
  if (gone.length) leave(targetID, gone)
}

// 테스트 전용: Date.now() 기준 유예가 지난 퇴장을 모두 처리한다(setSystemTime 과 함께 쓴다).
export function leaveSweep() {
  for (const targetID of Array.from(offline.keys())) settleLeaves(targetID)
}

export function submitActive(input: { sessionID: string; docID: string; actorID: string }) {
  return active(input.sessionID, input.docID, input.actorID)
}

export function questionSubmitActive(input: { sessionID: string; requestID: string; actorID: string }) {
  return active(input.sessionID, input.requestID, input.actorID)
}

export type Handle = (() => void) & { pong: () => void }
type SocketPeer = { send: (data: string) => void; close?: () => void }

function connect(input: {
  sessionID: string
  targetID: string
  actorID: string
  peer: SocketPeer
  observer?: boolean
}): Handle {
  if (input.observer) {
    const peer: LivePeer = { send: input.peer.send, close: input.peer.close, lastSeen: Date.now() }
    const set = observers.get(input.targetID) ?? new Set<LivePeer>()
    set.add(peer)
    observers.set(input.targetID, set)
    heartbeatStart()
    const state = active(input.sessionID, input.targetID)
    if (state) peer.send(JSON.stringify({ type: "created", state } satisfies SubmitEvent))
    const stop = () => {
      set.delete(peer)
      if (set.size === 0) observers.delete(input.targetID)
      heartbeatStop()
    }
    return Object.assign(stop, {
      pong: () => {
        peer.lastSeen = Date.now()
      },
    })
  }
  const peer: SubmitPeer = {
    actorID: input.actorID,
    send: input.peer.send,
    close: input.peer.close,
    lastSeen: Date.now(),
  }
  const set = peers.get(input.targetID) ?? new Set<SubmitPeer>()
  set.add(peer)
  peers.set(input.targetID, set)
  heartbeatStart()
  cancelLeave(input.targetID, input.actorID)
  const state = join(input.sessionID, input.targetID, input.actorID)
  if (state) {
    peer.send(JSON.stringify({ type: "created", state } satisfies SubmitEvent))
  } else {
    const last = recent(input.sessionID, input.targetID, input.actorID)
    if (last) peer.send(JSON.stringify({ type: last.status as SubmitEventType, state: last } satisfies SubmitEvent))
  }
  const stop = () => {
    set.delete(peer)
    if (!Array.from(set).some((item) => item.actorID === peer.actorID)) scheduleLeave(input.targetID, peer.actorID)
    if (set.size === 0) peers.delete(input.targetID)
    heartbeatStop()
  }
  return Object.assign(stop, {
    pong: () => {
      peer.lastSeen = Date.now()
    },
  })
}

export function submitConnect(input: {
  sessionID: string
  docID: string
  actorID: string
  peer: SocketPeer
  observer?: boolean
}) {
  get(input.docID)
  return connect({
    sessionID: input.sessionID,
    targetID: input.docID,
    actorID: input.actorID,
    peer: input.peer,
    observer: input.observer,
  })
}

export function questionSubmitConnect(input: {
  sessionID: string
  requestID: string
  actorID: string
  peer: SocketPeer
  observer?: boolean
}) {
  return connect({
    sessionID: input.sessionID,
    targetID: input.requestID,
    actorID: input.actorID,
    peer: input.peer,
    observer: input.observer,
  })
}

export type QuestionDraft = {
  requestID: string
  sessionID: string
  answers: string[][]
  custom: string[]
  customOn: boolean[]
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

const drafts = new Map<string, QuestionDraft>()
const presences = new Map<string, Map<string, QuestionPresenceEntry>>()
const draftPeers = new Map<string, Set<DraftPeer>>()
const draftLeaveTimers = new Map<string, ReturnType<typeof setTimeout>>()

function castDraft(requestID: string) {
  const set = draftPeers.get(requestID)
  const draft = drafts.get(requestID)
  if (!set || !draft) return
  const data = JSON.stringify({ type: "draft", draft })
  set.forEach((peer) => peer.send(data))
}

function castPresence(requestID: string) {
  const set = draftPeers.get(requestID)
  if (!set) return
  const presence = Array.from(presences.get(requestID)?.values() ?? [])
  const data = JSON.stringify({ type: "presence", presence })
  set.forEach((peer) => peer.send(data))
}

function ensureDraft(sessionID: string, requestID: string) {
  let draft = drafts.get(requestID)
  if (!draft) {
    draft = { requestID, sessionID, answers: [], custom: [], customOn: [], step: 0, rev: 0 }
    drafts.set(requestID, draft)
  }
  return draft
}

export function questionDraftApply(input: { sessionID: string; requestID: string; op: QuestionDraftOp }) {
  const draft = ensureDraft(input.sessionID, input.requestID)
  const op = input.op
  if (op.kind === "step") {
    draft.step = Math.max(0, Math.floor(op.value))
    draft.rev += 1
    castDraft(input.requestID)
    return draft
  }
  while (draft.answers.length <= op.q) draft.answers.push([])
  while (draft.custom.length <= op.q) draft.custom.push("")
  while (draft.customOn.length <= op.q) draft.customOn.push(false)

  if (op.kind === "single") {
    draft.answers[op.q] = op.value === null ? [] : [op.value]
    draft.customOn[op.q] = false
  } else if (op.kind === "toggle") {
    const cur = draft.answers[op.q] ?? []
    draft.answers[op.q] = op.on
      ? cur.includes(op.label)
        ? cur
        : [...cur, op.label]
      : cur.filter((item) => item !== op.label)
  } else {
    const prev = (draft.custom[op.q] ?? "").trim()
    const next = op.text.trim()
    draft.custom[op.q] = op.text
    draft.customOn[op.q] = op.on
    if (op.multi) {
      let cur = draft.answers[op.q] ?? []
      if (prev) cur = cur.filter((item) => item.trim() !== prev)
      if (op.on && next && !cur.some((item) => item.trim() === next)) cur = [...cur, op.text]
      draft.answers[op.q] = cur
    } else {
      draft.answers[op.q] = op.on && next ? [op.text] : []
    }
  }
  draft.rev += 1
  castDraft(input.requestID)
  return draft
}

export function questionPresenceSet(input: { sessionID: string; requestID: string; entry: QuestionPresenceEntry }) {
  const map = presences.get(input.requestID) ?? new Map<string, QuestionPresenceEntry>()
  map.set(input.entry.actorID, input.entry)
  presences.set(input.requestID, map)
  castPresence(input.requestID)
}

function dropPresence(requestID: string, actorID: string) {
  const map = presences.get(requestID)
  if (!map) return
  if (map.delete(actorID)) castPresence(requestID)
  if (map.size === 0) presences.delete(requestID)
}

function cancelDraftLeave(requestID: string, actorID: string) {
  const key = `draft:${requestID}:${actorID}`
  const timer = draftLeaveTimers.get(key)
  if (!timer) return
  clearTimeout(timer)
  draftLeaveTimers.delete(key)
}

function scheduleDraftLeave(requestID: string, actorID: string) {
  cancelDraftLeave(requestID, actorID)
  const key = `draft:${requestID}:${actorID}`
  const timer = setTimeout(() => {
    draftLeaveTimers.delete(key)
    const set = draftPeers.get(requestID)
    const online = set ? Array.from(set).some((peer) => peer.actorID === actorID) : false
    if (online) return
    dropPresence(requestID, actorID)
  }, LEAVE_GRACE)
  timer.unref?.()
  draftLeaveTimers.set(key, timer)
}

export function questionDraftReset(requestID: string) {
  drafts.delete(requestID)
  presences.delete(requestID)
  castPresence(requestID)
}

export function questionDraftConnect(input: {
  sessionID: string
  requestID: string
  actorID: string
  peer: SocketPeer
}) {
  const peer: DraftPeer = {
    actorID: input.actorID,
    send: input.peer.send,
    close: input.peer.close,
    lastSeen: Date.now(),
  }
  const set = draftPeers.get(input.requestID) ?? new Set<DraftPeer>()
  set.add(peer)
  draftPeers.set(input.requestID, set)
  heartbeatStart()
  cancelDraftLeave(input.requestID, input.actorID)
  const draft = drafts.get(input.requestID)
  if (draft) peer.send(JSON.stringify({ type: "draft", draft }))
  const presence = Array.from(presences.get(input.requestID)?.values() ?? [])
  if (presence.length) peer.send(JSON.stringify({ type: "presence", presence }))
  const stop = () => {
    set.delete(peer)
    if (!Array.from(set).some((item) => item.actorID === peer.actorID))
      scheduleDraftLeave(input.requestID, peer.actorID)
    if (set.size === 0) draftPeers.delete(input.requestID)
    heartbeatStop()
  }
  return Object.assign(stop, {
    pong: () => {
      peer.lastSeen = Date.now()
    },
  })
}

// 값 요청 초안. 비밀 값이 실리므로 세션 actor 로 등록된 참여자만 붙고, 요청이 닫히면 즉시 지운다. 디스크에는 쓰지 않는다.
export type EnvDraft = { requestID: string; sessionID: string; key: string; value: string; rev: number }
export type EnvDraftOp = { kind: "key"; text: string } | { kind: "value"; text: string }
export type EnvPresenceEntry = { actorID: string; name: string; color: string; editing: boolean }

const envDrafts = new Map<string, EnvDraft>()
const envPresences = new Map<string, Map<string, EnvPresenceEntry>>()
const envDraftPeers = new Map<string, Set<DraftPeer>>()
const envDraftLeaveTimers = new Map<string, ReturnType<typeof setTimeout>>()

function castEnvDraft(requestID: string) {
  const set = envDraftPeers.get(requestID)
  const draft = envDrafts.get(requestID)
  if (!set || !draft) return
  const data = JSON.stringify({ type: "draft", draft })
  set.forEach((peer) => peer.send(data))
}

function castEnvPresence(requestID: string) {
  const set = envDraftPeers.get(requestID)
  if (!set) return
  const presence = Array.from(envPresences.get(requestID)?.values() ?? [])
  const data = JSON.stringify({ type: "presence", presence })
  set.forEach((peer) => peer.send(data))
}

function ensureEnvDraft(sessionID: string, requestID: string, key: string) {
  let draft = envDrafts.get(requestID)
  if (!draft) {
    draft = { requestID, sessionID, key, value: "", rev: 0 }
    envDrafts.set(requestID, draft)
  }
  return draft
}

export function envDraftApply(input: { sessionID: string; requestID: string; key: string; op: EnvDraftOp }) {
  const draft = ensureEnvDraft(input.sessionID, input.requestID, input.key)
  if (input.op.kind === "key") draft.key = input.op.text
  else draft.value = input.op.text
  draft.rev += 1
  castEnvDraft(input.requestID)
  return draft
}

export function envPresenceSet(input: { sessionID: string; requestID: string; entry: EnvPresenceEntry }) {
  const map = envPresences.get(input.requestID) ?? new Map<string, EnvPresenceEntry>()
  map.set(input.entry.actorID, input.entry)
  envPresences.set(input.requestID, map)
  castEnvPresence(input.requestID)
}

function dropEnvPresence(requestID: string, actorID: string) {
  const map = envPresences.get(requestID)
  if (!map) return
  if (map.delete(actorID)) castEnvPresence(requestID)
  if (map.size === 0) envPresences.delete(requestID)
}

function cancelEnvLeave(requestID: string, actorID: string) {
  const key = `env:${requestID}:${actorID}`
  const timer = envDraftLeaveTimers.get(key)
  if (!timer) return
  clearTimeout(timer)
  envDraftLeaveTimers.delete(key)
}

function scheduleEnvLeave(requestID: string, actorID: string) {
  cancelEnvLeave(requestID, actorID)
  const key = `env:${requestID}:${actorID}`
  const timer = setTimeout(() => {
    envDraftLeaveTimers.delete(key)
    const set = envDraftPeers.get(requestID)
    const online = set ? Array.from(set).some((peer) => peer.actorID === actorID) : false
    if (online) return
    dropEnvPresence(requestID, actorID)
  }, LEAVE_GRACE)
  timer.unref?.()
  envDraftLeaveTimers.set(key, timer)
}

export function envDraftReset(requestID: string) {
  envDrafts.delete(requestID)
  envPresences.delete(requestID)
  castEnvPresence(requestID)
}

export function envDraftConnect(input: {
  sessionID: string
  requestID: string
  actorID: string
  key: string
  peer: SocketPeer
}): Handle | undefined {
  const actor = db()
    .query<ActorRow, [string, string]>("SELECT * FROM session_actor WHERE session_id = ? AND actor_id = ?")
    .get(input.sessionID, input.actorID)
  if (!actor) {
    input.peer.close?.()
    return undefined
  }
  const peer: DraftPeer = {
    actorID: input.actorID,
    send: input.peer.send,
    close: input.peer.close,
    lastSeen: Date.now(),
  }
  const set = envDraftPeers.get(input.requestID) ?? new Set<DraftPeer>()
  set.add(peer)
  envDraftPeers.set(input.requestID, set)
  heartbeatStart()
  cancelEnvLeave(input.requestID, input.actorID)
  const draft = ensureEnvDraft(input.sessionID, input.requestID, input.key)
  peer.send(JSON.stringify({ type: "draft", draft }))
  const presence = Array.from(envPresences.get(input.requestID)?.values() ?? [])
  if (presence.length) peer.send(JSON.stringify({ type: "presence", presence }))
  const stop = () => {
    set.delete(peer)
    if (!Array.from(set).some((item) => item.actorID === peer.actorID)) scheduleEnvLeave(input.requestID, peer.actorID)
    if (set.size === 0) envDraftPeers.delete(input.requestID)
    heartbeatStop()
  }
  return Object.assign(stop, {
    pong: () => {
      peer.lastSeen = Date.now()
    },
  })
}

export function actorUpsert(input: {
  sessionID: string
  actorID?: string
  userID?: string
  name?: string
  color?: string
}): ActorInfo {
  const byUser =
    !input.actorID && input.userID
      ? (db()
          .query<ActorRow, [string, string]>("SELECT * FROM session_actor WHERE session_id = ? AND user_id = ?")
          .get(input.sessionID, input.userID) ?? undefined)
      : undefined
  const actorID = input.actorID ?? byUser?.actor_id ?? Store.ascending("act")
  const existing =
    byUser ??
    db()
      .query<ActorRow, [string, string]>("SELECT * FROM session_actor WHERE session_id = ? AND actor_id = ?")
      .get(input.sessionID, actorID) ??
    undefined
  const name = (input.name ? cap(input.name) : "") || existing?.name || fallback(actorID)
  const userID = input.userID ?? existing?.user_id ?? null
  const picked = pickColor(input.sessionID, actorID, existing?.color, input.color)
  const now = Date.now()
  db().run(
    `INSERT INTO session_actor (session_id, actor_id, user_id, name, color, time_created, time_seen) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, actor_id) DO UPDATE SET user_id = excluded.user_id, name = excluded.name, color = excluded.color, time_seen = excluded.time_seen`,
    [input.sessionID, actorID, userID, name, picked, existing?.time_created ?? now, now],
  )
  return { actorID, sessionID: input.sessionID, ...(userID ? { userID } : {}), name, color: picked }
}

export function actorList(sessionID: string): ActorInfo[] {
  return actors(sessionID).map((row) => ({
    actorID: row.actor_id,
    sessionID: row.session_id,
    ...(row.user_id ? { userID: row.user_id } : {}),
    name: row.name,
    color: row.color,
  }))
}

export function resetForTest() {
  for (const timer of timers.values()) clearTimeout(timer)
  for (const timer of leaveTimers.values()) clearTimeout(timer)
  for (const timer of draftLeaveTimers.values()) clearTimeout(timer)
  for (const timer of envDraftLeaveTimers.values()) clearTimeout(timer)
  if (heartbeat) clearInterval(heartbeat)
  heartbeat = undefined
  timers.clear()
  leaveTimers.clear()
  offline.clear()
  draftLeaveTimers.clear()
  envDraftLeaveTimers.clear()
  peers.clear()
  observers.clear()
  drafts.clear()
  presences.clear()
  draftPeers.clear()
  envDrafts.clear()
  envPresences.clear()
  envDraftPeers.clear()
  Room.resetForTest()
}

export * as Doc from "./doc"
