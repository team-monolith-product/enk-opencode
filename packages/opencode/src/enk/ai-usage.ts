import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import { SentryReporter } from "@/util/sentry"
import type { MessageV2 } from "@/session/message-v2"

/**
 * Report AI token usage to enk-hackathon-rails `ai_usages/do_many`.
 *
 * Three record phases share one queue/drain/retry pipeline. Rails is expected to SUM the
 * cost/token columns across records (deduped by the idempotency key), so counts and fee ride
 * ONLY on the step records:
 *   - `reportStart()` — one zero-count record per assistant turn (`phase:"start"`,
 *                        step_index -1) marking "answer started".
 *   - `reportStep()`  — one record per model step (`phase:"step"`), emitted at `finish-step`.
 *                        Carries that call's authoritative token counts AND its fee; summing a
 *                        turn's step records yields the exact turn total ((input × n) + output).
 *   - `report()`      — one zero-count record when the turn ends (`phase:"final"`,
 *                        step_index -1), fired for normal completion AND user aborts — marks
 *                        "answer ended". Carries no fee/tokens so summing cannot double-bill.
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
  const API_PATH = "/api/v1/ai_usages/do_many"

  export type Phase = "start" | "step" | "final"

  // Per-record attributes expected by rails. owner_type/owner_id are derived server-side from
  // `mount_path` (first two segments), so we don't send them. The realtime fields (message_id,
  // step_index, phase, input/output/reasoning/cache_*) key each record by
  // (message_id, step_index, phase) so rails can upsert/dedupe before summing.
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

  /** Authoritative per-step usage as computed by Session.getUsage for one model call. */
  export type StepUsage = {
    index: number
    tokens: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
    cost: number
    at?: number
  }

  const pending: Attributes[] = [] // bounded FIFO queue
  const sent = new Set<string>() // idempotency keys already enqueued — dedupes repeated updates
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

  /** All-zero counts shared by the start/final marker records. */
  function markerAttributes(info: MessageV2.Assistant, phase: Phase, usedAt: number): Attributes {
    return {
      // The session working directory, sent verbatim — rails parses owner from it.
      mount_path: info.path.cwd,
      model_id: info.modelID,
      message_id: info.id,
      // -1 marks a turn-level record (not tied to any single step).
      step_index: -1,
      phase,
      // Markers carry no counts and no fee: rails sums cost/token columns across records, and
      // the turn's usage already went out on the step records — anything here would double-bill.
      tokens: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache_read: 0,
      cache_write: 0,
      cost: 0,
      used_at: new Date(usedAt).toISOString(),
    }
  }

  /** Build the turn-start marker record ("answer started"). */
  export function buildStartAttributes(info: MessageV2.Assistant): Attributes {
    return markerAttributes(info, "start", info.time.created)
  }

  /** Build the turn-end marker record ("answer ended", including user aborts). */
  export function buildAttributes(info: MessageV2.Assistant): Attributes {
    return markerAttributes(info, "final", info.time.completed!)
  }

  /** Build a per-step record: that model call's authoritative token counts and fee. */
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

  /** Enqueue the turn-end marker (phase:"final"). Non-blocking; never throws. */
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

  /** Enqueue authoritative per-step usage + fee (phase:"step"). Non-blocking; never throws. */
  export function reportStep(info: MessageV2.Assistant, step: StepUsage) {
    if (!enabled()) {
      warnDisabledOnce()
      return
    }
    if (info.role !== "assistant") return
    if (!info.path?.cwd) return
    enqueue(buildStepAttributes(info, step))
  }

  /**
   * Enqueue the turn-start marker (phase:"start"). Exactly one per assistant message — the
   * idempotency key dedupes the repeated stream "start" events that fallback retries produce.
   * Non-blocking; never throws.
   */
  export function reportStart(info: MessageV2.Assistant) {
    if (!enabled()) {
      warnDisabledOnce()
      return
    }
    if (info.role !== "assistant") return
    if (!info.path?.cwd) return
    enqueue(buildStartAttributes(info))
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
