// 기본 모델이 재시도를 다 쓰거나 재시도로 못 고치는 오류로 실패하면 그 턴의 나머지를 다음 모델로 잇는다.
// 풀은 ENK_AI_FALLBACK_MODELS(JSON 배열: "provider/model" 또는 { model, variant })로 바꿀 수 있다.
// 폴백이 ENK_AI_FALLBACK_STICKY_AFTER 번 쌓인 세션은 기본 모델에 재시도를 주지 않는다(한 번은 시도한다).

export interface Entry {
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
}

export interface Pair {
  readonly text: string
  readonly vision: string
}

export const DEFAULT_POOL: readonly Entry[] = [
  { providerID: "google", modelID: "gemini-3.5-flash", variant: "high" },
  { providerID: "minimax", modelID: "MiniMax-M3", variant: "adaptive" },
  { providerID: "anthropic", modelID: "claude-sonnet-5" },
]

// 비전 모델은 텍스트 짝으로 내려가지 않는다. 미디어가 실린 턴이 볼 수 없는 모델에 닿기 때문이다.
export const DEFAULT_PAIRS: readonly Pair[] = [{ text: "deepseek/deepseek-v4-pro", vision: "minimax/MiniMax-M3" }]

export function parseModel(raw?: string) {
  if (!raw) return undefined
  const slash = raw.indexOf("/")
  if (slash <= 0 || slash === raw.length - 1) return undefined
  return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) }
}

const key = (model: { providerID: string; modelID: string }) => `${model.providerID}/${model.modelID}`

const count = (name: string, fallback: number) => {
  const value = Number(process.env[name])
  return process.env[name] !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback
}

export const retries = () => count("ENK_AI_FALLBACK_RETRIES", 3)

const stickyAfter = () => count("ENK_AI_FALLBACK_STICKY_AFTER", 3)

export function pairs(env: NodeJS.ProcessEnv = process.env): Pair[] {
  const result = [...DEFAULT_PAIRS]
  const primary = parseModel(env.ENK_AI_MODEL)
  const image = parseModel(env.ENK_AI_IMAGE_MODEL)
  if (primary && image && key(primary) !== key(image)) result.push({ text: key(primary), vision: key(image) })
  return result
}

export function excluded(
  primary: { providerID: string; modelID: string },
  entry: Entry,
  list: readonly Pair[] = pairs(),
) {
  const primaryKey = key(primary)
  const entryKey = key(entry)
  if (primaryKey === entryKey) return false
  return list.some((pair) => pair.vision === primaryKey && pair.text === entryKey)
}

function entry(raw: unknown): Entry | undefined {
  if (typeof raw === "string") return parseModel(raw)
  if (typeof raw !== "object" || raw === null) return undefined
  const { model, variant } = raw as { model?: unknown; variant?: unknown }
  const parsed = typeof model === "string" ? parseModel(model) : undefined
  if (!parsed) return undefined
  return typeof variant === "string" && variant ? { ...parsed, variant } : parsed
}

// 잘못된 값은 통째로 무시하고 기본 풀을 쓴다. 명시적인 "[]" 는 폴백을 끈다.
export function parsePool(raw: string | undefined): Entry[] {
  if (!raw) return [...DEFAULT_POOL]
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return [...DEFAULT_POOL]
  }
  if (!Array.isArray(parsed)) return [...DEFAULT_POOL]
  return parsed.flatMap((item) => entry(item) ?? [])
}

// 기본 모델 뒤에 이어 붙일 후보. 같은 모델, 짝 규칙에 걸린 모델은 뺀다. 실제로 쓸 수 있는지는 호출자가 고른다.
export function candidates(primary: { providerID: string; modelID: string }, env: NodeJS.ProcessEnv = process.env) {
  const seen = new Set([key(primary)])
  const list = pairs(env)
  return parsePool(env.ENK_AI_FALLBACK_MODELS).filter((item) => {
    const itemKey = key(item)
    if (seen.has(itemKey)) return false
    seen.add(itemKey)
    return !excluded(primary, item, list)
  })
}

const fallbacks = new Map<string, number>()

export function degraded(sessionID: string) {
  return (fallbacks.get(sessionID) ?? 0) >= stickyAfter()
}

export function record(sessionID: string) {
  fallbacks.set(sessionID, (fallbacks.get(sessionID) ?? 0) + 1)
}

export function recovered(sessionID: string) {
  fallbacks.delete(sessionID)
}

// 설정에 모델이 없을 때만 ENK_AI_MODEL 을 쓴다. 가장 낮은 우선순위의 설정 문서로 넣어 같은 의미를 만든다.
export function defaultsConfig(env: NodeJS.ProcessEnv = process.env) {
  const model = parseModel(env.ENK_AI_MODEL) ? env.ENK_AI_MODEL : undefined
  return model ? JSON.stringify({ model }) : undefined
}

// ENK_AI_MODEL_VARIANT 는 기본 모델로 도는 build/plan 메인 세션에만 붙인다. 서브에이전트에는 붙이지 않는다.
export function defaultVariant(
  session: { readonly parentID?: string; readonly agent?: string },
  env: NodeJS.ProcessEnv = process.env,
) {
  if (session.parentID) return undefined
  if (session.agent !== undefined && session.agent !== "build" && session.agent !== "plan") return undefined
  return env.ENK_AI_MODEL_VARIANT || undefined
}

export * as ModelFallback from "./model-fallback.js"
