import { Flag } from "@/flag/flag"
import { AsyncQueue } from "@/util/queue"
import { Log } from "@/util/log"
import type { MessageV2 } from "@/session/message-v2"

/**
 * Report per-turn AI token usage to enk-hackathon-rails `ai_usages`.
 *
 * Fired from the message-update projector for every completed assistant message. Instead of
 * POSTing inline (which would block the projector and couple usage delivery to the AI turn),
 * each record is pushed onto an in-memory queue and drained SERIALLY in the background — the
 * `ai_usages` endpoint accepts one record at a time, not an array.
 *
 * Disabled (no-op) unless both ENK_HACKATHON_RAILS_URL and ENK_AI_USAGE_TOKEN are set, so
 * local/non-hackathon runs are unaffected. Delivery failures are isolated in the consumer and
 * never propagate back to the session. The queue is memory-only: records not yet sent when the
 * process exits are lost (acceptable for the hackathon).
 */
export namespace AiUsage {
  const log = Log.create({ service: "enk.ai-usage" })

  const MAX_ATTEMPTS = 5

  // JSON:API body shape expected by POST {ENK_HACKATHON_RAILS_URL}. owner_type/owner_id are
  // derived by rails from `mount_path` (first two segments), so we don't send them.
  type Body = {
    data: {
      type: "ai-usages"
      attributes: {
        mount_path: string
        model_id: string
        tokens: number
        cost: number
        used_at: string
      }
    }
  }

  const queue = new AsyncQueue<Body>()
  const sent = new Set<string>() // messageIDs already enqueued — dedupes repeated updates
  let started = false

  export function buildBody(info: MessageV2.Assistant): Body {
    const t = info.tokens
    const tokens =
      (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
    return {
      data: {
        type: "ai-usages",
        attributes: {
          // The session working directory, sent verbatim — rails parses owner from it.
          mount_path: info.path.cwd,
          model_id: info.modelID,
          tokens,
          cost: info.cost,
          used_at: new Date(info.time.completed!).toISOString(),
        },
      },
    }
  }

  /** Enqueue one completed assistant turn's usage. Non-blocking; safe to call on every update. */
  export function report(info: MessageV2.Info) {
    const url = Flag.ENK_HACKATHON_RAILS_URL
    const token = Flag.ENK_AI_USAGE_TOKEN
    if (!url || !token) return // feature disabled
    if (info.role !== "assistant") return
    if (!info.time.completed) return // only finished turns
    if (sent.has(info.id)) return // already enqueued
    if (!info.path?.cwd) return // no mount_path → rails can't resolve owner

    sent.add(info.id)
    queue.push(buildBody(info))
    start(url, token)
  }

  function start(url: string, token: string) {
    if (started) return
    started = true
    void consume(url, token)
  }

  async function consume(url: string, token: string) {
    for await (const body of queue) {
      await postWithRetry(url, token, body)
    }
  }

  async function postWithRetry(url: string, token: string, body: Body) {
    const mount = body.data.attributes.mount_path
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `token ${token}`,
          },
          body: JSON.stringify(body),
        })
        if (res.ok) return
        // 4xx (except 429) are permanent — retrying won't help (403 outside event window, 422
        // validation, 401 bad token). Drop with a log.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          log.warn("ai usage rejected", { status: res.status, mount })
          return
        }
        log.warn("ai usage post failed", { status: res.status, attempt, mount })
      } catch (err) {
        log.warn("ai usage post error", { err: String(err), attempt, mount })
      }
      if (attempt < MAX_ATTEMPTS) await delay(1000 * 2 ** (attempt - 1))
    }
    log.warn("ai usage dropped after retries", { mount })
  }

  function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
