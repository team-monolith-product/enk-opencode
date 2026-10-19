import type { Plugin } from "@opencode/plugin"

// enk-hackathon-rails ai_usages/do_many 로 턴마다 start, 모델 스텝마다 step(토큰·비용), 턴이 끝나면 final 을 보낸다.
// 비용과 토큰은 step 기록에만 싣고 rails 가 합산한다. 전송은 직렬 큐 하나로만 하므로 세션 진행을 막지 않는다.

export type Phase = "start" | "step" | "final"

export type Attributes = {
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

export type Tokens = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

type Context = Plugin.Context

type Event = {
  type: string
  location?: { directory?: string }
  data?: any
}

type Turn = {
  messageID?: string
  steps: number
  models: Map<string, string>
}

const MAX_ATTEMPTS = 5
const MAX_PENDING = 1000
const MAX_SENT_KEYS = 10_000
const BATCH_MAX = 50
const FLUSH_WINDOW_MS = 250
const API_PATH = "/api/v1/ai_usages/do_many"

export function remember(set: Set<string>, key: string, max: number) {
  set.add(key)
  if (set.size <= max) return
  for (const oldest of set) {
    set.delete(oldest)
    if (set.size <= max) return
  }
}

function marker(mountPath: string, modelID: string, messageID: string, phase: Phase, at: number): Attributes {
  return {
    mount_path: mountPath,
    model_id: modelID,
    message_id: messageID,
    step_index: -1,
    phase,
    tokens: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cache_read: 0,
    cache_write: 0,
    cost: 0,
    used_at: new Date(at).toISOString(),
  }
}

export function startAttributes(mountPath: string, modelID: string, messageID: string, at: number) {
  return marker(mountPath, modelID, messageID, "start", at)
}

export function finalAttributes(mountPath: string, modelID: string, messageID: string, at: number) {
  return marker(mountPath, modelID, messageID, "final", at)
}

export function stepAttributes(
  mountPath: string,
  modelID: string,
  messageID: string,
  index: number,
  usage: { tokens: Tokens; cost: number },
  at: number,
): Attributes {
  const { input, output, reasoning } = usage.tokens
  const cacheRead = usage.tokens.cache.read
  const cacheWrite = usage.tokens.cache.write
  return {
    mount_path: mountPath,
    model_id: modelID,
    message_id: messageID,
    step_index: index,
    phase: "step",
    tokens: input + output + reasoning + cacheRead + cacheWrite,
    input,
    output,
    reasoning,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    cost: usage.cost,
    used_at: new Date(at).toISOString(),
  }
}

export function createReporter(options: {
  url: string
  token: string
  fetch?: typeof fetch
  delay?: (ms: number) => Promise<void>
  log?: (message: string, extra?: Record<string, unknown>) => void
}) {
  const send = options.fetch ?? fetch
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const log = options.log ?? ((message, extra) => console.warn(`[jitda.ai-usage] ${message}`, extra ?? ""))
  const endpoint = options.url.replace(/\/+$/, "") + API_PATH
  const pending: Attributes[] = []
  const sent = new Set<string>()
  let draining: Promise<void> | undefined
  let dropped = 0

  async function post(records: Attributes[]) {
    const body = JSON.stringify({ data_to_create: records.map((attributes) => ({ type: "ai-usages", attributes })) })
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const res = await send(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `token ${options.token}` },
        body,
      }).catch((error: unknown) => {
        log("post error", { error: String(error), attempt, count: records.length })
        return undefined
      })
      if (res?.ok) return
      if (res && res.status >= 400 && res.status < 500 && res.status !== 429) {
        log("rejected", { status: res.status, count: records.length })
        return
      }
      if (attempt < MAX_ATTEMPTS) await delay(1000 * 2 ** (attempt - 1))
    }
    log("dropped after retries", { count: records.length })
  }

  async function drain() {
    while (pending.length) {
      if (pending.length < BATCH_MAX) await delay(FLUSH_WINDOW_MS)
      const batch = pending.splice(0, BATCH_MAX)
      if (batch.length) await post(batch)
    }
    draining = undefined
  }

  return {
    enqueue(record: Attributes, key = `${record.message_id}:${record.step_index}:${record.phase}`) {
      if (sent.has(key)) return
      if (pending.length >= MAX_PENDING) {
        dropped++
        if (dropped % 100 === 1) log("queue full, dropping", { dropped, max: MAX_PENDING })
        return
      }
      remember(sent, key, MAX_SENT_KEYS)
      pending.push(record)
      draining ??= drain()
    },
    flush() {
      return draining ?? Promise.resolve()
    },
  }
}

export type Reporter = ReturnType<typeof createReporter>

const modelID = (model: { id?: string } | undefined) => model?.id ?? ""

export function createTracker(reporter: Reporter, directory: string, now: () => number = Date.now) {
  const turns = new Map<string, Turn>()
  const sessions = new Set<string>()

  const turn = (sessionID: string) => {
    const existing = turns.get(sessionID)
    if (existing) return existing
    const created: Turn = { steps: 0, models: new Map() }
    turns.set(sessionID, created)
    return created
  }

  const step = (sessionID: string, data: any) => {
    if (data.cost === undefined && data.tokens === undefined) return
    const current = turn(sessionID)
    const messageID = current.messageID ?? data.assistantMessageID
    reporter.enqueue(
      stepAttributes(
        directory,
        current.models.get(data.assistantMessageID) ?? "",
        messageID,
        current.steps++,
        {
          cost: data.cost ?? 0,
          tokens: data.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        now(),
      ),
    )
  }

  return (event: Event) => {
    const data = event.data ?? {}
    const sessionID: string | undefined = data.sessionID
    if (!sessionID) return
    if (event.location) {
      if (event.location.directory !== directory) return
      sessions.add(sessionID)
    } else if (!sessions.has(sessionID)) return
    switch (event.type) {
      case "session.deleted":
        sessions.delete(sessionID)
        turns.delete(sessionID)
        return
      case "session.execution.started":
        turns.set(sessionID, { steps: 0, models: new Map() })
        return
      case "session.step.started": {
        const current = turn(sessionID)
        const model = modelID(data.model)
        current.models.set(data.assistantMessageID, model)
        if (current.messageID) return
        current.messageID = data.assistantMessageID
        reporter.enqueue(startAttributes(directory, model, data.assistantMessageID, data.started ?? now()))
        return
      }
      case "session.step.ended":
      case "session.step.failed":
        step(sessionID, data)
        return
      case "session.compaction.ended":
        reporter.enqueue(
          stepAttributes(
            directory,
            modelID(data.model),
            `${sessionID}:compaction:${now()}`,
            0,
            { cost: data.cost ?? 0, tokens: data.tokens },
            now(),
          ),
        )
        return
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        const current = turns.get(sessionID)
        turns.delete(sessionID)
        if (!current?.messageID) return
        reporter.enqueue(
          finalAttributes(directory, current.models.get(current.messageID) ?? "", current.messageID, now()),
        )
        return
      }
    }
  }
}

export function start(ctx: Context) {
  const url = process.env.ENK_HACKATHON_RAILS_URL
  const token = process.env.ENK_AI_USAGE_TOKEN
  if (!url || !token) return () => {}
  const observe = createTracker(createReporter({ url, token }), ctx.location.directory)
  const controller = new AbortController()
  void (async () => {
    while (!controller.signal.aborted) {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) observe(event as Event)
      } catch (error) {
        if (controller.signal.aborted) return
        console.warn("[jitda.ai-usage] event stream ended", String(error))
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  })()
  return () => controller.abort()
}

export * as AiUsage from "./ai-usage"
