import { Database, eq, inArray } from "@/storage/db"
import { MessageTable, PartTable } from "@/session/session.sql"
import { MessageV2 } from "@/session/message-v2"
import type { MessageID, SessionID } from "@/session/schema"
import { Log } from "@/util/log"
import {
  PromptCycleTable,
  PromptCycleInputTable,
  PromptCycleLinkTable,
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
    const isData = typeof p.url === "string" && p.url.startsWith("data:")
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

// The user message that started the run `userMessageID` belongs to (itself when it started one).
function anchorOf(db: Database.TxOrDb, userMessageID: string) {
  const row = db
    .select({ anchor: PromptCycleLinkTable.anchor_user_message_id })
    .from(PromptCycleLinkTable)
    .where(eq(PromptCycleLinkTable.user_message_id, userMessageID))
    .get()
  return row?.anchor ?? userMessageID
}

/**
 * The run started by `anchorID` read `userMessageID`, a user message it did not start with: a steer
 * or a consented send that landed mid-run, or one the run created itself (auto-compaction, a subtask
 * summary). Called by the run loop right when it reads the message — before any answer to it exists —
 * so the recorder folds that answer into the run's cycle instead of opening a new one.
 *
 * The anchor is resolved first: a run that re-starts for a message which already joined an earlier
 * run keeps feeding that earlier run's cycle. The first run to read a message owns it.
 */
export function link(input: {
  sessionID: SessionID
  userMessageID: MessageID
  anchorID: MessageID
  /** The message re-sends an earlier prompt (auto-compaction replay): fold its answer, not its text. */
  replay?: boolean
}) {
  Database.use((db) => {
    const anchor = anchorOf(db, input.anchorID)
    if (anchor === input.userMessageID) return
    db.insert(PromptCycleLinkTable)
      .values({
        user_message_id: input.userMessageID,
        anchor_user_message_id: anchor,
        replay: input.replay ?? false,
        session_id: input.sessionID,
        time_created: Date.now(),
      })
      .onConflictDoNothing()
      .run()
  })
}

/**
 * Record one prompt cycle per AI run. A run starts from one user message (its anchor) and can go
 * on for many assistant messages (multi-step agent loop) — and it can absorb more user messages
 * while it runs (see link()). Every completed step answering the anchor or a linked message is
 * AGGREGATED into the anchor's cycle: tokens/cost summed, response texts joined, and each real
 * prompt kept as one input (seq 0 = the anchor, then in arrival order).
 *
 * Runs inside the message-update projector transaction, so it fires for EVERY prompt path
 * (normal / shell / doc). Idempotent: re-derives the whole cycle — inputs included — from the
 * stored messages each time, so duplicate events converge to the same rows.
 */
export function record(db: Database.TxOrDb, info: MessageV2.Info) {
  if (info.role !== "assistant") return
  if (!info.time.completed) return // only finished steps
  if (!info.parentID) return // no turn anchor
  derive(db, info.sessionID, anchorOf(db, info.parentID))
}

/**
 * Re-derive the cycle a user message belongs to. For facts that arrive after the run's steps were
 * recorded — a consent vote links its user message only once the message exists, and a steer can be
 * answered before that link lands.
 */
export function refresh(db: Database.TxOrDb, userMessageID: MessageID) {
  const anchor = anchorOf(db, userMessageID)
  const row = db.select({ session_id: MessageTable.session_id }).from(MessageTable).where(eq(MessageTable.id, anchor as MessageID)).get()
  if (!row) return
  derive(db, row.session_id, anchor)
}

function derive(db: Database.TxOrDb, sessionID: SessionID, anchorID: string) {
  const links = db
    .select({ id: PromptCycleLinkTable.user_message_id, replay: PromptCycleLinkTable.replay })
    .from(PromptCycleLinkTable)
    .where(eq(PromptCycleLinkTable.anchor_user_message_id, anchorID))
    .all()
  const replays = new Set(links.filter((row) => row.replay).map((row) => row.id))
  const memberIDs = [anchorID, ...links.map((row) => row.id)]
  const members = db
    .select()
    .from(MessageTable)
    .where(inArray(MessageTable.id, memberIDs as MessageID[]))
    .all()
    .sort((a, b) => a.time_created - b.time_created || (a.id < b.id ? -1 : 1))
  const anchor = members.find((m) => m.id === anchorID)
  if (!anchor) return
  const memberSet = new Set(memberIDs)

  // All completed assistant steps of this run, in order.
  const steps = db
    .select()
    .from(MessageTable)
    .where(eq(MessageTable.session_id, sessionID))
    .all()
    .map((m) => ({ id: m.id, data: m.data as AssistantData }))
    .filter(
      (m) =>
        m.data?.role === "assistant" &&
        m.data.parentID !== undefined &&
        memberSet.has(m.data.parentID) &&
        m.data.time?.completed,
    )
    .sort((a, b) => (a.data.time?.created ?? 0) - (b.data.time?.created ?? 0))
  if (steps.length === 0) return

  // Aggregate token/cost across steps; join non-empty response texts in order.
  let tokensInput = 0
  let tokensOutput = 0
  let tokensReasoning = 0
  let tokensCacheRead = 0
  let tokensCacheWrite = 0
  let cost = 0
  const responses: string[] = []
  for (const s of steps) {
    const parts = partsOf(db, s.id as MessageID)
    const tk = tokensOf(parts, s.data)
    tokensInput += tk.input ?? 0
    tokensOutput += tk.output ?? 0
    tokensReasoning += tk.reasoning ?? 0
    tokensCacheRead += tk.cache?.read ?? 0
    tokensCacheWrite += tk.cache?.write ?? 0
    cost += s.data.cost ?? 0
    const text = textOf(parts)
    if (text) responses.push(text)
  }
  const first = steps[0]!
  const last = steps[steps.length - 1]!
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

  // One input per real prompt. The anchor always counts; a joined message counts only if a person
  // wrote it — the run's own messages (compaction, continue, subtask summary) carry no text of their
  // own (synthetic), and a compaction replay repeats a prompt already counted; both are folded in
  // silently.
  const inputs = members
    .map((m) => {
      if (replays.has(m.id)) return
      const parts = partsOf(db, m.id as MessageID)
      const prompt = textOf(parts)
      const assets = assetsOf(parts)
      if (m.id !== anchorID && !prompt && !assets) return
      const meta = metaOf(parts)
      return {
        message: m,
        prompt,
        assets,
        docID: meta.docID ?? sessionDoc,
        consent: resolveConsent(db, m.id as MessageID, meta.actorID),
      }
    })
    .filter((item) => item !== undefined)

  const promptStart = anchor.time_created
  // TTFT from when the prompt was actually sent to the AI (consent for a doc submit, else
  // when it was authored) to the first assistant step.
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

  const existing = db
    .select({ id: PromptCycleTable.id })
    .from(PromptCycleTable)
    .where(eq(PromptCycleTable.user_message_id, anchorID))
    .get()
  const cycleID = existing?.id ?? CycleID.ascending()
  if (existing) db.update(PromptCycleTable).set(cycleValues).where(eq(PromptCycleTable.id, cycleID)).run()
  else
    db.insert(PromptCycleTable)
      .values({ id: cycleID, ...cycleValues })
      .run()

  // Inputs are re-derived every time (a joined prompt or a late consent link can change them), but
  // an input keeps its id across rewrites so callers holding it still find it.
  const ids = new Map(
    db
      .select({ id: PromptCycleInputTable.id, user_message_id: PromptCycleInputTable.user_message_id })
      .from(PromptCycleInputTable)
      .where(eq(PromptCycleInputTable.cycle_id, cycleID))
      .all()
      .map((row) => [row.user_message_id, row.id] as const),
  )
  db.delete(PromptCycleInputTable).where(eq(PromptCycleInputTable.cycle_id, cycleID)).run()
  if (inputs.length > 0)
    db.insert(PromptCycleInputTable)
      .values(
        inputs.map((item, seq) => ({
          id: ids.get(item.message.id) ?? CycleInputID.ascending(),
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
        })),
      )
      .run()
  log.info(existing ? "updated cycle" : "recorded cycle", {
    cycleID,
    session: sessionID,
    steps: steps.length,
    inputs: inputs.length,
    status,
  })
}
