import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import { SentryReporter } from "@/util/sentry"
import type { MessageV2 } from "@/session/message-v2"

/**
 * Report AI token usage to enk-hackathon-rails `ai_usages/do_many`.
 *
 * Two reporting granularities share one queue/drain/retry pipeline:
 *   - `report()`      — one record per COMPLETED assistant turn (`phase:"final"`). This is the
 *                        authoritative turn total and the reconciliation backstop: if any
 *                        incremental step POST is permanently dropped, the final still lands.
 *   - `reportStep()`  — one record per model step (`phase:"step"`), emitted at `finish-step`.
 *                        Carries authoritative per-step token/cost counts so the hub sees usage
 *                        stream in real time within a turn (tool loops produce many steps).
 *   - `reportProgress()` — optional lightweight liveness ping (`phase:"start"`, no token counts),
 *                        throttled per session. Opt-in via ENK_AI_USAGE_REALTIME=progress.
 *
 * Everything only enqueues — the POST runs off a single serial drain loop, so it is never awaited
 * by the projector / stream loop and cannot affect opencode's responsiveness. Three bounds keep a
 * dead endpoint from piling up: the drain is serial (at most ONE request in flight), records are
 * batched per POST (`BATCH_MAX`) with a small flush window so step bursts coalesce, and the
 * pending queue is capped (`MAX_PENDING`) so memory can't grow without limit — overflow is
 * dropped with a log.
 *
 * Idempotency: each record carries an idempotency key `(message_id, step_index, phase)`; the
 * client dedupes via a Set so retries/re-renders don't double-enqueue, and rails should upsert on
 * the same key so backoff retries don't double-count.
 *
 * Disabled (no-op) unless both ENK_HACKATHON_RAILS_URL and ENK_AI_USAGE_TOKEN are set, so
 * local/non-hackathon runs are unaffected. ENK_HACKATHON_RAILS_URL is host-only; we append the
 * API path. The queue is memory-only: anything unsent at process exit is lost (acceptable).
 */
export namespace AiUsage {
  const log = Log.create({ service: "enk.ai-usage" })

  const MAX_ATTEMPTS = 5
  const MAX_PENDING = 1000
  const BATCH_MAX = 50 // max records per POST (do_many accepts an array)
  const FLUSH_WINDOW_MS = 250 // coalesce bursts of step reports into one request
  const PROGRESS_THROTTLE_MS = 1500 // min gap between progress pings per session
  const API_PATH = "/api/v1/ai_usages/do_many"

  export type Phase = "start" | "step" | "final"

  // Per-record attributes expected by rails. owner_type/owner_id are derived server-side from
  // `mount_path` (first two segments), so we don't send them. New realtime fields (message_id,
  // step_index, phase, input/output/reasoning/cache_*) let rails distinguish incremental vs final
  // and key incremental records by (mount_path, message_id, step_index).
  type Attributes = {
    mount_path: string
    model_id: string
    message_id: string
    step_index: number
    phase: Phase
    tokens: number
    input: number
    output: number
    reasoning: number
    cache_read: number
    cache_write: number
    cost: number
    used_at: string
  }

  /** Authoritative per-step usage as computed by Session.getUsage. */
  export type StepUsage = {
    index: number
    tokens: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
    cost: number
    at?: number
  }

  const pending: Attributes[] = [] // bounded FIFO queue
  const sent = new Set<string>() // idempotency keys already enqueued — dedupes repeated updates
  const lastProgressAt = new Map<string, number>() // sessionID -> last progress ping timestamp
  let draining = false // serial-drain guard: at most one request in flight
  let dropped = 0 // records discarded due to MAX_PENDING overflow
  let warnedDisabled = false // suppress repeated "not configured" warnings

  function enabled() {
    return Boolean(Flag.ENK_HACKATHON_RAILS_URL && Flag.ENK_AI_USAGE_TOKEN)
  }

  function warnDisabledOnce() {
    if (warnedDisabled) return
    warnedDisabled = true
    log.warn("ai usage reporting disabled: ENK_HACKATHON_RAILS_URL or ENK_AI_USAGE_TOKEN not set")
  }

  function idempotencyKey(messageID: string, stepIndex: number, phase: Phase) {
    return `${messageID}:${stepIndex}:${phase}`
  }

  /** Build the final-turn record (cumulative turn totals). */
  export function buildAttributes(info: MessageV2.Assistant): Attributes {
    const t = info.tokens
    const input = t.input ?? 0
    const output = t.output ?? 0
    const reasoning = t.reasoning ?? 0
    const cacheRead = t.cache?.read ?? 0
    const cacheWrite = t.cache?.write ?? 0
    return {
      // The session working directory, sent verbatim — rails parses owner from it.
      mount_path: info.path.cwd,
      model_id: info.modelID,
      message_id: info.id,
      // -1 marks the turn-level final record (not tied to any single step).
      step_index: -1,
      phase: "final",
      tokens: input + output + reasoning + cacheRead + cacheWrite,
      input,
      output,
      reasoning,
      cache_read: cacheRead,
      cache_write: cacheWrite,
      cost: info.cost,
      used_at: new Date(info.time.completed!).toISOString(),
    }
  }

  /** Build an incremental per-step record. */
  export function buildStepAttributes(info: MessageV2.Assistant, step: StepUsage): Attributes {
    const input = step.tokens.input ?? 0
    const output = step.tokens.output ?? 0
    const reasoning = step.tokens.reasoning ?? 0
    const cacheRead = step.tokens.cache?.read ?? 0
    const cacheWrite = step.tokens.cache?.write ?? 0
    return {
      mount_path: info.path.cwd,
      model_id: info.modelID,
      message_id: info.id,
      step_index: step.index,
      phase: "step",
      tokens: input + output + reasoning + cacheRead + cacheWrite,
      input,
      output,
      reasoning,
      cache_read: cacheRead,
      cache_write: cacheWrite,
      cost: step.cost,
      used_at: new Date(step.at ?? Date.now()).toISOString(),
    }
  }

  function enqueue(record: Attributes) {
    const key = idempotencyKey(record.message_id, record.step_index, record.phase)
    if (sent.has(key)) return // already enqueued — dedupe retries / re-renders
    sent.add(key)
    if (pending.length >= MAX_PENDING) {
      dropped++
      if (dropped % 100 === 1) {
        log.warn("ai usage queue full, dropping", { dropped, max: MAX_PENDING })
        SentryReporter.captureException(new Error("ai usage queue full"), { dropped, max: MAX_PENDING })
      }
      return
    }
    pending.push(record)
    void drain()
  }

  /** Enqueue one completed assistant turn's usage (phase:"final"). Non-blocking; never throws. */
  export function report(info: MessageV2.Info) {
    if (!enabled()) {
      warnDisabledOnce()
      return
    }
    if (info.role !== "assistant") return
    if (!info.time.completed) return // only finished turns
    if (!info.path?.cwd) return // no mount_path → rails can't resolve owner
    enqueue(buildAttributes(info))
  }

  /** Enqueue authoritative per-step usage (phase:"step"). Non-blocking; never throws. */
  export function reportStep(info: MessageV2.Assistant, step: StepUsage) {
    if (!enabled()) {
      warnDisabledOnce()
      return
    }
    if (Flag.ENK_AI_USAGE_REALTIME === "off") return // realtime disabled → final-only
    if (info.role !== "assistant") return
    if (!info.path?.cwd) return
    enqueue(buildStepAttributes(info, step))
  }

  /**
   * Enqueue a lightweight liveness ping (phase:"start", no token counts). Opt-in via
   * ENK_AI_USAGE_REALTIME=progress and throttled to ≤1 per PROGRESS_THROTTLE_MS per session.
   * Non-blocking; never throws.
   */
  export function reportProgress(info: MessageV2.Assistant, kind: "start" = "start") {
    if (!enabled()) {
      warnDisabledOnce()
      return
    }
    if (Flag.ENK_AI_USAGE_REALTIME !== "progress") return
    if (info.role !== "assistant") return
    if (!info.path?.cwd) return

    const now = Date.now()
    const last = lastProgressAt.get(info.sessionID) ?? 0
    if (now - last < PROGRESS_THROTTLE_MS) return // throttle: coalesce — only latest state matters
    lastProgressAt.set(info.sessionID, now)

    // Progress pings carry no authoritative token counts (deltas have none). They are a pure
    // "answer happening now" signal. Dedupe by (message_id, now) so each ping is distinct.
    const record: Attributes = {
      mount_path: info.path.cwd,
      model_id: info.modelID,
      message_id: info.id,
      step_index: now, // use timestamp so successive progress pings don't collide in the sent Set
      phase: "start",
      tokens: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache_read: 0,
      cache_write: 0,
      cost: 0,
      used_at: new Date(now).toISOString(),
    }
    void kind
    enqueue(record)
  }

  async function drain() {
    if (draining) return
    draining = true
    try {
      while (pending.length) {
        // Small flush window: let a burst of step reports accumulate so they coalesce into one
        // POST instead of one request per step.
        if (pending.length < BATCH_MAX) await delay(FLUSH_WINDOW_MS)
        const batch = pending.splice(0, BATCH_MAX) // up to BATCH_MAX records per request
        if (!batch.length) continue
        await postWithRetry(batch) // one batch in flight at a time
      }
    } finally {
      draining = false
    }
  }

  async function postWithRetry(records: Attributes[]) {
    const url = Flag.ENK_HACKATHON_RAILS_URL!.replace(/\/+$/, "") + API_PATH
    const token = Flag.ENK_AI_USAGE_TOKEN!
    const body = JSON.stringify({
      data_to_create: records.map((attributes) => ({ type: "ai-usages", attributes })),
    })
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // Transmission log: address + method + time (no payload).
        log.info("sending", { method: "POST", url, at: new Date().toISOString(), attempt, count: records.length })
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `token ${token}` },
          body,
        })
        if (res.ok) return
        // 4xx (except 429) are permanent — retrying won't help (403 outside event window / owner
        // mismatch, 422 validation, 401 bad token). Drop with a log.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          log.warn("ai usage rejected", { status: res.status, count: records.length })
          SentryReporter.captureException(new Error("ai usage rejected"), { status: res.status, count: records.length })
          return
        }
        log.warn("ai usage post failed", { status: res.status, attempt, count: records.length })
      } catch (err) {
        log.warn("ai usage post error", { err: String(err), attempt, count: records.length })
        SentryReporter.captureException(err, { attempt, count: records.length })
      }
      if (attempt < MAX_ATTEMPTS) await delay(1000 * 2 ** (attempt - 1))
    }
    log.warn("ai usage dropped after retries", { count: records.length })
    SentryReporter.captureException(new Error("ai usage dropped after retries"), { count: records.length })
  }

  function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
