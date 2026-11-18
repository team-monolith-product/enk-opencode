import { Database, and, eq, gte, inArray, sql } from "@/storage/db"
import { MessageTable, PartTable } from "@/session/session.sql"
import { RunLink } from "@/session/run-link"
import { MessageV2 } from "@/session/message-v2"
import type { MessageID, SessionID } from "@/session/schema"
import { Log } from "@/util/log"
import {
  PromptCycleTable,
  PromptCycleInputTable,
  SessionPromptDocTable,
  DocSubmitTable,
  DocSubmitActorTable,
} from "./doc.sql"
import { CycleID, CycleInputID } from "./schema"
import type { ActorID, DocID } from "./schema"

const log = Log.create({ service: "doc.cycle-recorder" })

type Tokens = { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }

// The shape of a message part's JSON `data` payload (the fields the recorder reads).
type PartData = {
  type?: string
  text?: string
  synthetic?: boolean
  ignored?: boolean
  mime?: string
  filename?: string
  url?: string
  metadata?: { actorID?: string; docID?: string }
  tokens?: Tokens // step-finish
  prompt?: string // subtask
}

// Read a message's parts once, ordered, as plain data objects.
function partsOf(db: Database.TxOrDb, messageID: MessageID): PartData[] {
  return db
    .select()
    .from(PartTable)
    .where(eq(PartTable.message_id, messageID))
    .orderBy(PartTable.id)
    .all()
    .map((row) => row.data as PartData)
}

// Join verbatim text parts (skipping synthetic/ignored).
function textOf(parts: PartData[]) {
  const out: string[] = []
  for (const p of parts) {
    if (p?.type === "text" && !p.synthetic && !p.ignored && typeof p.text === "string") out.push(p.text)
  }
  return out.join("\n")
}

// What a person asked for in a user message: its verbatim text, plus the prompt of any subtask
// command they ran (a slash command that delegates to a subagent carries no text part of its own).
function promptOf(parts: PartData[]) {
  const subtasks = parts.filter((p) => p?.type === "subtask" && typeof p.prompt === "string").map((p) => p.prompt!)
  return [textOf(parts), ...subtasks].filter(Boolean).join("\n")
}

// Pull the asset id out of a reference URL like `/doc/{docID}/asset/{assetID}` (with an
// optional query/fragment). Prefers the `/asset/<id>` segment; falls back to the last path
// segment. Tolerates trailing slashes and `?`/`#` suffixes.
function assetIdFromUrl(url: string): string | undefined {
  const clean = url.split(/[?#]/)[0]!.replace(/\/+$/, "")
  return clean.match(/\/asset\/([^/]+)$/)?.[1] ?? clean.split("/").pop() ?? undefined
}

// File attachments as lightweight references — never the raw bytes. Inline data: URLs
// (base64 blobs) are recorded as {mime, filename} only; real reference URLs keep url + assetID.
function assetsOf(parts: PartData[]) {
  const out: { assetID?: string; mime: string; filename?: string; url?: string }[] = []
  for (const p of parts) {
    if (p?.type !== "file") continue
    const isData = typeof p.url === "string" && (p.url.startsWith("data:") || p.url.startsWith("media:"))
    out.push({
      mime: p.mime ?? "",
      filename: p.filename,
      ...(isData ? {} : { url: p.url, assetID: p.url ? assetIdFromUrl(p.url) : undefined }),
    })
  }
  return out.length ? out : null
}

// The doc/actor the app stamps onto the prompt's text part metadata.
function metaOf(parts: PartData[]): { actorID: ActorID | null; docID: DocID | null } {
  for (const p of parts) {
    if (p?.type === "text" && p.metadata) {
      return {
        actorID: (p.metadata.actorID as ActorID) ?? null,
        docID: (p.metadata.docID as DocID) ?? null,
      }
    }
  }
  return { actorID: null, docID: null }
}

// Resolve who sent/consented an input, plus consent timing.
//  - multi-party consent (a doc_submit links to this user message) → all its actors
//  - solo doc send (no submit) → the single sender from the message metadata
//  - normal/non-doc prompt → no actor identity at all
function resolveConsent(db: Database.TxOrDb, userMessageID: MessageID, soloActorID: ActorID | null) {
  const submit = db.select().from(DocSubmitTable).where(eq(DocSubmitTable.user_message_id, userMessageID)).get()
  if (submit) {
    const actors = db
      .select({ actor_id: DocSubmitActorTable.actor_id })
      .from(DocSubmitActorTable)
      .where(eq(DocSubmitActorTable.submit_id, submit.id))
      .all()
    const actorIDs = actors.map((a) => a.actor_id)
    return {
      submitID: submit.id,
      actorIDs: actorIDs.length ? actorIDs : null,
      initiatorActorID: submit.actor_id, // whoever created (first pressed send on) the submit
      actorCount: actorIDs.length || 1,
      timeConsented: submit.time_updated,
      consentMs: Math.max(0, submit.time_updated - submit.time_created),
    }
  }
  // Solo: the lone sender is both the only actor and the initiator.
  return {
    submitID: null,
    actorIDs: soloActorID ? [soloActorID] : null,
    initiatorActorID: soloActorID,
    actorCount: 1,
    timeConsented: null,
    consentMs: null,
  }
}

// The assistant message info fields the aggregator reads off MessageTable.data.
type AssistantData = {
  role?: string
  parentID?: string
  cost?: number
  tokens?: Tokens
  modelID?: string
  providerID?: string
  path?: { cwd?: string; root?: string }
  time?: { created?: number; completed?: number }
  error?: { name?: string; data?: { message?: string } }
}

// One assistant message's token usage. A message can hold several model calls (one step-finish
// part each), but the message itself keeps only the LAST call's counts — right for judging the
// context size, wrong for a usage total. Sum the step-finish parts; fall back to the message's own
// counts when it has none (a refused turn, older data).
function tokensOf(parts: PartData[], data: AssistantData) {
  const steps = parts.filter((p) => p?.type === "step-finish" && p.tokens)
  if (steps.length === 0) return data.tokens ?? {}
  const sum = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  for (const p of steps) {
    sum.input += p.tokens?.input ?? 0
    sum.output += p.tokens?.output ?? 0
    sum.reasoning += p.tokens?.reasoning ?? 0
    sum.cache.read += p.tokens?.cache?.read ?? 0
    sum.cache.write += p.tokens?.cache?.write ?? 0
  }
  return sum
}

// A finished step's usage and response text. The recorder re-derives the whole run every time a step
// finishes, so without this every step would re-read the parts of every earlier step — quadratic in
// a long agent run, inside the projector's write transaction. Keyed by session as well (message ids
// are only unique per database); an entry is only used for the same completion time, and forget()
// drops it whenever one of the message's parts changes — a forked session copies a completed message
// first and its parts after, so "completed" alone does not mean the parts are in.
//
// Bounded by the text it holds, not just by entry count — a response can be tens of KB of code, and
// the cache only has to cover the runs being recorded right now. The oldest entries go first (the
// Map keeps insertion order and a re-read entry is re-inserted); a dropped entry is simply read again.
type StepSummary = { tokens: Tokens; text: string }
const STEP_CACHE_MAX_ENTRIES = 5_000
const STEP_CACHE_MAX_CHARS = 4_000_000 // ~8 MB of UTF-16 text
const stepCache = new Map<string, { completed: number | undefined; summary: StepSummary }>()
let stepCacheChars = 0
const stepKey = (sessionID: string, messageID: string) => `${sessionID}:${messageID}`

function drop(key: string) {
  const entry = stepCache.get(key)
  if (!entry) return
  stepCacheChars -= entry.summary.text.length
  stepCache.delete(key)
}

function summaryOf(db: Database.TxOrDb, sessionID: string, messageID: string, data: AssistantData): StepSummary {
  const key = stepKey(sessionID, messageID)
  const hit = stepCache.get(key)
  if (hit && hit.completed === data.time?.completed) return hit.summary
  const parts = partsOf(db, messageID as MessageID)
  const summary = { tokens: tokensOf(parts, data), text: textOf(parts) }
  drop(key)
  // A single step bigger than the whole budget is not kept at all.
  if (summary.text.length > STEP_CACHE_MAX_CHARS) return summary
  while (
    stepCache.size > 0 &&
    (stepCache.size >= STEP_CACHE_MAX_ENTRIES || stepCacheChars + summary.text.length > STEP_CACHE_MAX_CHARS)
  )
    drop(stepCache.keys().next().value!)
  stepCache.set(key, { completed: data.time?.completed, summary })
  stepCacheChars += summary.text.length
  return summary
}

/** A part of this message was written or removed: its cached step summary, if any, is stale. */
export function forget(sessionID: string, messageID: string) {
  drop(stepKey(sessionID, messageID))
}

/** What the step cache holds right now — for tests and diagnostics. */
export function cacheUsage() {
  return { entries: stepCache.size, chars: stepCacheChars }
}

/**
 * Record one prompt cycle per AI run. A run starts from one user message (its anchor) and can go
 * on for many assistant messages (multi-step agent loop) — and it can absorb more user messages
 * while it runs (see RunLink). Every completed step answering the anchor or a linked message is
 * AGGREGATED into the anchor's cycle: tokens/cost summed, response texts joined, and each real
 * prompt kept as one input (seq 0 = the anchor, then in the order they were stored).
 *
 * Runs inside the message-update projector transaction, so it fires for EVERY prompt path
 * (normal / shell / doc). Idempotent: re-derives the whole cycle — inputs included — from the
 * stored messages each time, so duplicate events converge to the same rows.
 */
export function record(db: Database.TxOrDb, info: MessageV2.Info) {
  if (info.role !== "assistant") return
  if (!info.time.completed) return // only finished steps
  if (!info.parentID) return // no turn anchor
  derive(db, info.sessionID, RunLink.anchorOf(db, info.parentID))
}

/**
 * Record a stored assistant message again, for parts that arrived after it completed (see the
 * part-updated projector). Does nothing unless it is a finished step.
 */
export function recordStored(db: Database.TxOrDb, sessionID: SessionID, messageID: string) {
  const row = db
    .select({ data: MessageTable.data })
    .from(MessageTable)
    .where(eq(MessageTable.id, messageID as MessageID))
    .get()
  const data = row?.data as AssistantData | undefined
  if (data?.role !== "assistant" || !data.time?.completed || !data.parentID) return
  derive(db, sessionID, RunLink.anchorOf(db, data.parentID))
}

/**
 * Re-derive the cycle a user message belongs to. For facts that arrive after the run's steps were
 * recorded — a consent vote links its user message only once the message exists, and a steer can be
 * answered before that link lands.
 */
export function refresh(db: Database.TxOrDb, userMessageID: MessageID) {
  const anchor = RunLink.anchorOf(db, userMessageID)
  const row = db
    .select({ session_id: MessageTable.session_id })
    .from(MessageTable)
    .where(eq(MessageTable.id, anchor as MessageID))
    .get()
  if (!row) return
  // Called right after a send stores its message, so usually nothing has answered it yet. Only a run
  // already on record is known to have steps somewhere; otherwise an empty range means "not answered
  // yet", not "stored out of order", and is no reason to read the whole session.
  const recorded = db
    .select({ id: PromptCycleTable.id })
    .from(PromptCycleTable)
    .where(eq(PromptCycleTable.user_message_id, anchor))
    .get()
  derive(db, row.session_id, anchor, { expectSteps: !!recorded })
}

/**
 * `expectSteps`: the caller knows the run has a finished step (record() is called for one), so an
 * empty range means the stored order broke — worth the whole-session fallback. Without it an empty
 * range just means nothing has answered yet.
 */
function derive(
  db: Database.TxOrDb,
  sessionID: SessionID,
  anchorID: string,
  opts: { expectSteps: boolean } = { expectSteps: true },
) {
  const links = RunLink.members(db, anchorID)
  const replays = new Set<string>(links.filter((item) => item.replay).map((item) => item.id))
  const memberIDs = [anchorID, ...links.map((item) => item.id)]
  // Members in the order they were stored (rowid), never by timestamp — see RunLink.
  const members = db
    .select({ id: MessageTable.id, time_created: MessageTable.time_created, row: sql<number>`rowid` })
    .from(MessageTable)
    .where(inArray(MessageTable.id, memberIDs as MessageID[]))
    .all()
    .sort((a, b) => a.row - b.row)
  const anchor = members.find((m) => m.id === anchorID)
  if (!anchor) return
  const memberSet = new Set<string>(memberIDs)

  // A message linked into this run may have answered steps recorded as a cycle of its own before the
  // link existed (a link written late by some future path). Those steps now count here; drop the
  // stale cycle so nothing is counted twice.
  const stale = members.filter((m) => m.id !== anchorID).map((m) => m.id)
  if (stale.length > 0) db.delete(PromptCycleTable).where(inArray(PromptCycleTable.user_message_id, stale)).run()

  // All completed assistant steps of this run, in stored order. A step is stored after the message it
  // answers, so only rows from the run's earliest member on can belong to it — read just those
  // instead of the whole session on every step. The earliest member, not the anchor: a message written
  // out of order (an import, a replay) must not hide its own steps.
  const isStep = (m: { data: unknown }) => {
    const data = m.data as AssistantData
    return data?.role === "assistant" && !!data.parentID && memberSet.has(data.parentID) && !!data.time?.completed
  }
  const from = Math.min(...members.map((m) => m.row))
  let steps = db
    .select({ id: MessageTable.id, data: MessageTable.data, row: sql<number>`rowid` })
    .from(MessageTable)
    .where(and(gte(sql`rowid`, from), eq(MessageTable.session_id, sessionID)))
    .all()
    .filter(isStep)
  if (steps.length === 0 && opts.expectSteps) {
    // Nothing in range although record() was called for a finished step: the stored order broke the
    // assumption above. Fall back to the whole session rather than lose the run, and say so.
    steps = db
      .select({ id: MessageTable.id, data: MessageTable.data, row: sql<number>`rowid` })
      .from(MessageTable)
      .where(eq(MessageTable.session_id, sessionID))
      .all()
      .filter(isStep)
    if (steps.length > 0) log.warn("run steps stored before their anchor", { session: sessionID, anchor: anchorID })
  }
  if (steps.length === 0) return
  steps.sort((a, b) => a.row - b.row)
  const runSteps = steps.map((s) => ({ id: s.id, data: s.data as AssistantData }))

  // Aggregate token/cost across steps; join non-empty response texts in order.
  let tokensInput = 0
  let tokensOutput = 0
  let tokensReasoning = 0
  let tokensCacheRead = 0
  let tokensCacheWrite = 0
  let cost = 0
  const responses: string[] = []
  for (const s of runSteps) {
    const { tokens: tk, text } = summaryOf(db, sessionID, s.id, s.data)
    tokensInput += tk.input ?? 0
    tokensOutput += tk.output ?? 0
    tokensReasoning += tk.reasoning ?? 0
    tokensCacheRead += tk.cache?.read ?? 0
    tokensCacheWrite += tk.cache?.write ?? 0
    cost += s.data.cost ?? 0
    if (text) responses.push(text)
  }
  const first = runSteps[0]!
  const last = runSteps[runSteps.length - 1]!
  // The run ends the way its last step ended. An earlier step that failed and was recovered from —
  // a model fallback, a steer re-run after an error — does not make the whole run a failure.
  const lastError = last.data.error
  const aborted = lastError?.name === "MessageAbortedError"
  const errorMessage = lastError ? (lastError.data?.message ?? lastError.name ?? "error") : null
  const status = aborted ? "aborted" : errorMessage ? "error" : "completed"

  // The session's current prompt doc: the fallback docID for prompts with no doc metadata.
  const sessionDoc =
    db
      .select({ doc_id: SessionPromptDocTable.doc_id })
      .from(SessionPromptDocTable)
      .where(eq(SessionPromptDocTable.session_id, sessionID))
      .get()?.doc_id ?? null

  const existing = db
    .select({ id: PromptCycleTable.id })
    .from(PromptCycleTable)
    .where(eq(PromptCycleTable.user_message_id, anchorID))
    .get()
  const cycleID = existing?.id ?? CycleID.ascending()

  // What each input already settled carries over: its id, so callers holding it still find it, and
  // the doc it was filed under — a consented steer rotates the session's prompt doc mid-run, and an
  // earlier prompt without doc metadata must not move to that new doc.
  const previous = new Map(
    db
      .select()
      .from(PromptCycleInputTable)
      .where(eq(PromptCycleInputTable.cycle_id, cycleID))
      .all()
      .map((row) => [row.user_message_id, row] as const),
  )

  // One input per real prompt. The anchor always counts; a joined message counts only if a person
  // wrote it — the run's own messages (compaction, continue, subtask summary) carry no text of their
  // own (synthetic), and a compaction replay repeats a prompt already counted; both are folded in
  // silently.
  const inputs = members
    .map((m) => {
      if (replays.has(m.id)) return
      const parts = partsOf(db, m.id as MessageID)
      const prompt = promptOf(parts)
      const assets = assetsOf(parts)
      if (m.id !== anchorID && !prompt && !assets) return
      const meta = metaOf(parts)
      return {
        message: m,
        prompt,
        assets,
        docID: meta.docID ?? previous.get(m.id)?.doc_id ?? sessionDoc,
        consent: resolveConsent(db, m.id as MessageID, meta.actorID),
      }
    })
    .filter((item) => item !== undefined)

  const promptStart = anchor.time_created
  // TTFT from when the prompt was actually sent to the AI (consent for a doc submit, else
  // when it was authored) to the first assistant step. Both are server-stamped durations.
  const ttftStart = inputs[0]?.consent.timeConsented ?? promptStart
  const outputStart = first.data.time?.created ?? promptStart

  const cycleValues = {
    session_id: sessionID,
    user_message_id: anchorID,
    path: last.data.path?.cwd ?? null,
    time_created: promptStart,
    assistant_message_id: last.id,
    response: responses.join("\n\n"),
    model_id: last.data.modelID ?? null,
    provider_id: last.data.providerID ?? null,
    time_output_start: outputStart,
    time_completed: last.data.time?.completed ?? null,
    ttft_ms: Math.max(0, outputStart - ttftStart),
    tokens_input: tokensInput,
    tokens_output: tokensOutput,
    tokens_reasoning: tokensReasoning,
    tokens_cache_read: tokensCacheRead,
    tokens_cache_write: tokensCacheWrite,
    cost_total: cost,
    status,
    aborted,
    error: errorMessage,
  }

  if (existing) db.update(PromptCycleTable).set(cycleValues).where(eq(PromptCycleTable.id, cycleID)).run()
  else
    db.insert(PromptCycleTable)
      .values({ id: cycleID, ...cycleValues })
      .run()

  // Write only what changed: most steps of a long run leave every input as it was, so rewriting them
  // all would be pure churn (and would fire anything that later hangs off an input row).
  const wanted = inputs.map((item, seq) => ({
    id: previous.get(item.message.id)?.id ?? CycleInputID.ascending(),
    cycle_id: cycleID,
    session_id: sessionID,
    doc_id: item.docID,
    submit_id: item.consent.submitID,
    actor_ids: item.consent.actorIDs,
    initiator_actor_id: item.consent.initiatorActorID,
    actor_count: item.consent.actorCount,
    seq,
    prompt: item.prompt,
    assets: item.assets,
    user_message_id: item.message.id,
    time_created: item.message.time_created,
    time_consented: item.consent.timeConsented,
    consent_ms: item.consent.consentMs,
  }))
  const keep = new Set<string | null>(wanted.map((row) => row.user_message_id))
  for (const [messageID, row] of previous) {
    if (keep.has(messageID)) continue
    db.delete(PromptCycleInputTable)
      .where(and(eq(PromptCycleInputTable.cycle_id, cycleID), eq(PromptCycleInputTable.id, row.id)))
      .run()
  }
  for (const row of wanted) {
    const before = previous.get(row.user_message_id)
    if (!before) {
      db.insert(PromptCycleInputTable).values(row).run()
      continue
    }
    if (sameInput(before, row)) continue
    db.update(PromptCycleInputTable)
      .set(row)
      .where(and(eq(PromptCycleInputTable.cycle_id, cycleID), eq(PromptCycleInputTable.id, row.id)))
      .run()
  }
  log.info(existing ? "updated cycle" : "recorded cycle", {
    cycleID,
    session: sessionID,
    steps: runSteps.length,
    inputs: inputs.length,
    status,
  })
}

type InputRow = typeof PromptCycleInputTable.$inferSelect

// Whether a stored input already says what a fresh derivation would write.
function sameInput(before: InputRow, after: InputRow) {
  return (Object.keys(after) as (keyof InputRow)[]).every(
    (key) => JSON.stringify(before[key] ?? null) === JSON.stringify(after[key] ?? null),
  )
}
