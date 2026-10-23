// session.generate(옆 질문·세션 워밍)는 모델 루프 밖이라 스텝 이벤트가 없다. 한도를 먼저 보고, 쓴 비용은 로컬 한도에서 깎고 rails 에 따로 보고한다.
import { CostQuota } from "./cost-quota.js"

const API_PATH = "/api/v1/ai_usages/do_many"

export type Usage = {
  directory: string
  modelID: string
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  cost: number
}

export function attributes(usage: Usage, messageID: string, at: number) {
  const { input, output, reasoning, cache } = usage.tokens
  return {
    mount_path: usage.directory,
    model_id: usage.modelID,
    message_id: messageID,
    step_index: -3,
    phase: "step",
    tokens: input + output + reasoning + cache.read + cache.write,
    input,
    output,
    reasoning,
    cache_read: cache.read,
    cache_write: cache.write,
    cost: usage.cost,
    used_at: new Date(at).toISOString(),
  }
}

export function report(usage: Usage, send: typeof fetch = fetch) {
  CostQuota.consume(usage.cost)
  const url = process.env.ENK_HACKATHON_RAILS_URL
  const token = process.env.ENK_AI_USAGE_TOKEN
  if (!url || !token) return Promise.resolve()
  const record = attributes(usage, `gen_${crypto.randomUUID()}`, Date.now())
  return send(url.replace(/\/+$/, "") + API_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `token ${token}` },
    body: JSON.stringify({ data_to_create: [{ type: "ai-usages", attributes: record }] }),
  }).then(
    (res) => {
      if (!res.ok) console.warn("[jitda.generate-usage] rejected", res.status)
    },
    (error: unknown) => console.warn("[jitda.generate-usage] post error", String(error)),
  )
}

export * as GenerateUsage from "./generate-usage.js"
