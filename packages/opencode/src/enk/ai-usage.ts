import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import type { MessageV2 } from "@/session/message-v2"

/**
 * Report AI token usage to enk-hackathon-rails `ai_usages/do_many`, one record per completed
 * assistant turn.
 *
 * `report()` only enqueues — the POST runs off a single serial drain loop, so it is never
 * awaited by the projector / AI turn and cannot affect opencode's responsiveness. Two bounds
 * keep a dead endpoint from piling up: the drain is serial (at most ONE request in flight), and
 * the pending queue is capped (`MAX_PENDING`) so memory can't grow without limit — overflow is
 * dropped with a log.
 *
 * Disabled (no-op) unless both ENK_HACKATHON_RAILS_URL and ENK_AI_USAGE_TOKEN are set, so
 * local/non-hackathon runs are unaffected. ENK_HACKATHON_RAILS_URL is host-only; we append the
 * API path. The queue is memory-only: anything unsent at process exit is lost (acceptable).
 */
export namespace AiUsage {
  const log = Log.create({ service: "enk.ai-usage" })

  const MAX_ATTEMPTS = 5
  const MAX_PENDING = 1000
  const API_PATH = "/api/v1/ai_usages/do_many"

  // Per-record attributes expected by rails. owner_type/owner_id are derived server-side from
  // `mount_path` (first two segments), so we don't send them.
  type Attributes = {
    mount_path: string
    model_id: string
    tokens: number
    cost: number
    used_at: string
  }

  const pending: Attributes[] = [] // bounded FIFO queue
  const sent = new Set<string>() // messageIDs already enqueued — dedupes repeated updates
  let draining = false // serial-drain guard: at most one request in flight
  let dropped = 0 // records discarded due to MAX_PENDING overflow
  let warnedDisabled = false // suppress repeated "not configured" warnings

  function enabled() {
    return Boolean(Flag.ENK_HACKATHON_RAILS_URL && Flag.ENK_AI_USAGE_TOKEN)
  }

  export function buildAttributes(info: MessageV2.Assistant): Attributes {
    const t = info.tokens
    return {
      // The session working directory, sent verbatim — rails parses owner from it.
      mount_path: info.path.cwd,
      model_id: info.modelID,
      tokens: (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0),
      cost: info.cost,
      used_at: new Date(info.time.completed!).toISOString(),
    }
  }

  /** Enqueue one completed assistant turn's usage. Non-blocking; never throws into the caller. */
  export function report(info: MessageV2.Info) {
    if (!enabled()) {
      if (!warnedDisabled) {
        warnedDisabled = true
        log.warn("ai usage reporting disabled: ENK_HACKATHON_RAILS_URL or ENK_AI_USAGE_TOKEN not set")
      }
      return
    }
    if (info.role !== "assistant") return
    if (!info.time.completed) return // only finished turns
    if (sent.has(info.id)) return // already enqueued
    if (!info.path?.cwd) return // no mount_path → rails can't resolve owner

    sent.add(info.id)
    if (pending.length >= MAX_PENDING) {
      dropped++
      if (dropped % 100 === 1) log.warn("ai usage queue full, dropping", { dropped, max: MAX_PENDING })
      return
    }
    pending.push(buildAttributes(info))
    void drain()
  }

  async function drain() {
    if (draining) return
    draining = true
    try {
      while (pending.length) {
        const record = pending.shift()!
        await postWithRetry([record]) // one in flight at a time
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
        log.info("sending", { method: "POST", url, at: new Date().toISOString(), attempt })
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
          return
        }
        log.warn("ai usage post failed", { status: res.status, attempt, count: records.length })
      } catch (err) {
        log.warn("ai usage post error", { err: String(err), attempt, count: records.length })
      }
      if (attempt < MAX_ATTEMPTS) await delay(1000 * 2 ** (attempt - 1))
    }
    log.warn("ai usage dropped after retries", { count: records.length })
  }

  function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
