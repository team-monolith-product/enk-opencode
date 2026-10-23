import { Store } from "./store"

// 프롬프트 사이클 기록. 사용자 메시지 하나(턴)와 그 뒤 다음 사용자 메시지 전까지의 어시스턴트 스텝을 한 사이클로 묶는다.
// V1 은 assistant.parentID 로 턴을 찾았지만 V2 메시지에는 부모가 없어 타임라인 순서로 묶는다.
// 매번 턴 전체를 다시 계산해 user_message_id 로 upsert 하므로 같은 이벤트가 여러 번 와도 결과가 같다.

type Time = number | string | undefined

export type Message = {
  id: string
  type: string
  text?: string
  files?: { mime?: string; name?: string; source?: { uri?: string; type?: string } & Record<string, unknown> }[]
  metadata?: Record<string, unknown>
  model?: { id?: string; providerID?: string }
  content?: { type: string; text?: string }[]
  cost?: number
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  error?: { type?: string; message?: string }
  time?: { created?: Time; completed?: Time }
}

const ms = (value: Time) => {
  if (value === undefined) return undefined
  if (typeof value === "number") return value
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

const ABORTED = /abort/i

type Jitda = { docID?: string; submitID?: string; actorID?: string }

function jitda(message: Message): Jitda {
  const value = message.metadata?.jitda
  return value && typeof value === "object" ? (value as Jitda) : {}
}

function assetID(url: string) {
  const clean = url.split(/[?#]/)[0]!.replace(/\/+$/, "")
  return clean.match(/\/asset\/([^/]+)$/)?.[1] ?? clean.split("/").pop() ?? undefined
}

function assets(message: Message) {
  const out = (message.files ?? []).map((file) => {
    const uri = typeof file.source?.uri === "string" ? file.source.uri : undefined
    const reference = uri && !uri.startsWith("data:") ? uri : undefined
    return {
      mime: file.mime ?? "",
      ...(file.name ? { filename: file.name } : {}),
      ...(reference ? { url: reference, assetID: assetID(reference) } : {}),
    }
  })
  return out.length ? out : null
}

type SubmitRow = { id: string; actor_id: string; time_created: number; time_updated: number }

function consent(userMessageID: string, meta: Jitda) {
  const db = Store.db()
  const submit =
    db
      .query<SubmitRow, [string]>("SELECT id, actor_id, time_created, time_updated FROM doc_submit WHERE user_message_id = ?")
      .get(userMessageID) ??
    (meta.submitID
      ? db
          .query<SubmitRow, [string]>("SELECT id, actor_id, time_created, time_updated FROM doc_submit WHERE id = ?")
          .get(meta.submitID)
      : null)
  if (submit) {
    const ids = db
      .query<{ actor_id: string }, [string]>("SELECT actor_id FROM doc_submit_actor WHERE submit_id = ? ORDER BY rowid")
      .all(submit.id)
      .map((row) => row.actor_id)
    return {
      submitID: submit.id,
      actorIDs: ids.length ? ids : null,
      initiatorActorID: submit.actor_id,
      actorCount: ids.length || 1,
      timeConsented: submit.time_updated,
      consentMs: Math.max(0, submit.time_updated - submit.time_created),
    }
  }
  const solo = meta.actorID ?? null
  return {
    submitID: null,
    actorIDs: solo ? [solo] : null,
    initiatorActorID: solo,
    actorCount: 1,
    timeConsented: null,
    consentMs: null,
  }
}

export function turns(messages: Message[]) {
  const result: { user: Message; steps: Message[] }[] = []
  let current: { user: Message; steps: Message[] } | undefined
  for (const message of messages) {
    if (message.type === "user") {
      current = { user: message, steps: [] }
      result.push(current)
      continue
    }
    if (message.type === "assistant" && current) current.steps.push(message)
  }
  return result
}

export function record(input: { sessionID: string; directory?: string; messages: Message[]; interrupted?: boolean }) {
  const db = Store.db()
  const list = turns(input.messages)
  let written = 0
  list.forEach((turn, index) => {
    const steps = turn.steps
      .filter((step) => ms(step.time?.completed) !== undefined)
      .sort((a, b) => (ms(a.time?.created) ?? 0) - (ms(b.time?.created) ?? 0))
    if (steps.length === 0) return
    let tokensInput = 0
    let tokensOutput = 0
    let tokensReasoning = 0
    let tokensCacheRead = 0
    let tokensCacheWrite = 0
    let cost = 0
    const responses: string[] = []
    let aborted = false
    let error: string | null = null
    for (const step of steps) {
      const tokens = step.tokens ?? {}
      tokensInput += tokens.input ?? 0
      tokensOutput += tokens.output ?? 0
      tokensReasoning += tokens.reasoning ?? 0
      tokensCacheRead += tokens.cache?.read ?? 0
      tokensCacheWrite += tokens.cache?.write ?? 0
      cost += step.cost ?? 0
      const text = (step.content ?? [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
      if (text) responses.push(text)
      if (step.error) {
        if (ABORTED.test(step.error.type ?? "")) aborted = true
        error = step.error.message ?? step.error.type ?? "error"
      }
    }
    const last = steps[steps.length - 1]!
    const first = steps[0]!
    // 마지막 턴이 사용자 중지로 끝났으면 오류 없이 끝난 스텝이라도 중단으로 남긴다.
    if (input.interrupted && index === list.length - 1) aborted = true
    const status = aborted ? "aborted" : error ? "error" : "completed"
    const meta = jitda(turn.user)
    const agreed = consent(turn.user.id, meta)
    const docID =
      meta.docID ??
      db
        .query<{ doc_id: string }, [string]>("SELECT doc_id FROM session_prompt_doc WHERE session_id = ?")
        .get(input.sessionID)?.doc_id ??
      null
    const promptStart = ms(turn.user.time?.created) ?? Date.now()
    const outputStart = ms(first.time?.created) ?? promptStart
    const ttftStart = agreed.timeConsented ?? promptStart
    const values = {
      session_id: input.sessionID,
      user_message_id: turn.user.id,
      path: input.directory ?? null,
      time_created: promptStart,
      assistant_message_id: last.id,
      response: responses.join("\n\n"),
      model_id: last.model?.id ?? null,
      provider_id: last.model?.providerID ?? null,
      time_output_start: outputStart,
      time_completed: ms(last.time?.completed) ?? null,
      ttft_ms: Math.max(0, outputStart - ttftStart),
      tokens_input: tokensInput,
      tokens_output: tokensOutput,
      tokens_reasoning: tokensReasoning,
      tokens_cache_read: tokensCacheRead,
      tokens_cache_write: tokensCacheWrite,
      cost_total: cost,
      status,
      aborted: aborted ? 1 : 0,
      error,
    }
    const keys = Object.keys(values) as (keyof typeof values)[]
    const existing = db
      .query<{ id: string }, [string]>("SELECT id FROM prompt_cycle WHERE user_message_id = ?")
      .get(turn.user.id)
    if (existing) {
      db.run(`UPDATE prompt_cycle SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE id = ?`, [
        ...keys.map((key) => values[key]),
        existing.id,
      ])
      written++
      return
    }
    const cycleID = Store.ascending("cyc")
    db.transaction(() => {
      db.run(
        `INSERT INTO prompt_cycle (id, ${keys.join(", ")}) VALUES (?, ${keys.map(() => "?").join(", ")})`,
        [cycleID, ...keys.map((key) => values[key])],
      )
      db.run(
        `INSERT INTO prompt_cycle_input (id, cycle_id, session_id, doc_id, submit_id, actor_ids, initiator_actor_id, actor_count, seq, prompt, assets, user_message_id, time_created, time_consented, consent_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
        [
          Store.ascending("cin"),
          cycleID,
          input.sessionID,
          docID,
          agreed.submitID,
          agreed.actorIDs ? JSON.stringify(agreed.actorIDs) : null,
          agreed.initiatorActorID,
          agreed.actorCount,
          turn.user.text ?? "",
          (() => {
            const list = assets(turn.user)
            return list ? JSON.stringify(list) : null
          })(),
          turn.user.id,
          promptStart,
          agreed.timeConsented,
          agreed.consentMs,
        ],
      )
    })()
    written++
  })
  return written
}

type CycleRow = Record<string, unknown> & { id: string }
type InputRow = Record<string, unknown> & { id: string }

function input(row: InputRow) {
  const parse = (value: unknown) => (typeof value === "string" ? (JSON.parse(value) as unknown) : null)
  return {
    id: row.id,
    docID: row.doc_id ?? null,
    submitID: row.submit_id ?? null,
    actorIDs: parse(row.actor_ids),
    initiatorActorID: row.initiator_actor_id ?? null,
    seq: row.seq,
    prompt: row.prompt,
    assets: parse(row.assets),
    actorCount: row.actor_count,
    userMessageID: row.user_message_id ?? null,
    timeCreated: row.time_created,
    timeConsented: row.time_consented ?? null,
    consentMs: row.consent_ms ?? null,
  }
}

function cycle(row: CycleRow) {
  const inputs = Store.db()
    .query<InputRow, [string]>("SELECT * FROM prompt_cycle_input WHERE cycle_id = ? ORDER BY seq")
    .all(row.id)
    .map(input)
  return {
    id: row.id,
    sessionID: row.session_id,
    timeCreated: row.time_created,
    inputs,
    assistantMessageID: row.assistant_message_id ?? null,
    response: row.response ?? null,
    modelID: row.model_id ?? null,
    providerID: row.provider_id ?? null,
    timeOutputStart: row.time_output_start ?? null,
    timeCompleted: row.time_completed ?? null,
    ttftMs: row.ttft_ms ?? null,
    tokensInput: row.tokens_input ?? null,
    tokensOutput: row.tokens_output ?? null,
    tokensReasoning: row.tokens_reasoning ?? null,
    tokensCacheRead: row.tokens_cache_read ?? null,
    tokensCacheWrite: row.tokens_cache_write ?? null,
    costTotal: row.cost_total ?? null,
    status: row.status,
    aborted: !!row.aborted,
    error: row.error ?? null,
  }
}

export const STATUSES = ["running", "completed", "aborted", "error"] as const

export function list(input: { sessionID?: string; docID?: string; status?: string; limit?: number; offset?: number }) {
  const filters: string[] = []
  const args: (string | number)[] = []
  if (input.sessionID) {
    filters.push("session_id = ?")
    args.push(input.sessionID)
  }
  if (input.docID) {
    filters.push("id IN (SELECT cycle_id FROM prompt_cycle_input WHERE doc_id = ?)")
    args.push(input.docID)
  }
  if (input.status) {
    filters.push("status = ?")
    args.push(input.status)
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : ""
  return Store.db()
    .query<CycleRow, (string | number)[]>(
      `SELECT * FROM prompt_cycle ${where} ORDER BY time_created DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, input.limit ?? 100, input.offset ?? 0)
    .map(cycle)
}

export function get(cycleID: string) {
  const row = Store.db().query<CycleRow, [string]>("SELECT * FROM prompt_cycle WHERE id = ?").get(cycleID)
  return row ? cycle(row) : null
}

export * as Recorder from "./recorder"
