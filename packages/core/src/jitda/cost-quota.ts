// 팀당 주·월 AI 비용 한도(달러)는 rails 가 센다. 모델을 부르기 전에 남은 양을 묻고, 바닥나면 턴을 시작하지 않는다.
// rails 에 닿지 못하면 막지 않는다. 응답은 30초 들고 가고, 그 사이 pod 안의 소비는 consume() 이 로컬로 깎는다.

export type Locale = "ko" | "en"

export type Window = { readonly remaining: number; readonly resets_at: string }

export type Quota = {
  readonly exhausted: boolean
  readonly weekly: Window | null
  readonly monthly: Window | null
}

const ROUTE = "/api/v1/opencode/cost_quota"
const TIMEOUT_MS = 5_000
const CACHE_TTL_MS = 30_000
const TIME_ZONE = "Asia/Seoul"
const NONE: Quota = { exhausted: false, weekly: null, monthly: null }

let cache: { quota: Quota; at: number } | undefined

function backend() {
  const url = process.env.ENK_HACKATHON_RAILS_URL
  const token = process.env.ENK_AI_USAGE_TOKEN
  if (!url || !token) return undefined
  return { url: url.replace(/\/+$/, "") + ROUTE, token }
}

export function reset() {
  cache = undefined
}

function window(value: unknown): Window | null | undefined {
  if (value === null) return null
  if (typeof value !== "object" || value === undefined) return undefined
  const { remaining, resets_at } = value as Record<string, unknown>
  if (typeof remaining !== "number" || typeof resets_at !== "string") return undefined
  return { remaining, resets_at }
}

export function parse(value: unknown): Quota | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const input = value as Record<string, unknown>
  const weekly = window(input.weekly)
  const monthly = window(input.monthly)
  if (typeof input.exhausted !== "boolean" || weekly === undefined || monthly === undefined) return undefined
  return { exhausted: input.exhausted, weekly, monthly }
}

async function request(rails: { url: string; token: string }) {
  const res = await fetch(rails.url, {
    headers: { Authorization: `token ${rails.token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => undefined)
  if (!res) return undefined
  if (res.status === 403) return NONE
  if (!res.ok) return undefined
  return parse(await res.json().catch(() => undefined))
}

export async function check(now = Date.now()): Promise<Quota | undefined> {
  const rails = backend()
  if (!rails) return undefined
  if (!cache || now - cache.at >= CACHE_TTL_MS)
    cache = { quota: (await request(rails)) ?? cache?.quota ?? NONE, at: now }
  return cache.quota
}

export function spend(quota: Quota, cost: number): Quota {
  const spent = (value: Window | null) =>
    value && { ...value, remaining: Math.max(Number((value.remaining - cost).toFixed(8)), 0) }
  const weekly = spent(quota.weekly)
  const monthly = spent(quota.monthly)
  return { exhausted: [weekly, monthly].some((value) => value !== null && value.remaining <= 0), weekly, monthly }
}

export function consume(cost: number) {
  if (!cache || cost <= 0) return
  cache = { ...cache, quota: spend(cache.quota, cost) }
}

function blocking(quota: Quota) {
  return [quota.weekly, quota.monthly]
    .filter((value): value is Window => value !== null && value.remaining <= 0)
    .sort((a, b) => Date.parse(b.resets_at) - Date.parse(a.resets_at))[0]
}

const COPY = {
  ko: {
    tag: "ko-KR",
    month: "long",
    weekly: "이번 주",
    monthly: "이번 달",
    text: (label: string, at: string) => `${label} AI 사용 한도를 모두 사용했습니다. ${at}에 다시 사용할 수 있어요.`,
  },
  en: {
    tag: "en-US",
    month: "short",
    weekly: "This week's",
    monthly: "This month's",
    text: (label: string, at: string) => `${label} AI usage limit has been used up. It resets on ${at} (KST).`,
  },
} as const

// 날짜와 시각을 따로 포맷해 잇는다. 한 포맷터에 맡기면 ICU 버전마다 연결 문구가 달라진다.
export function message(quota: Quota, locale: Locale = "ko") {
  const blocked = blocking(quota)
  if (!blocked) return ""
  const copy = COPY[locale]
  const resetsAt = new Date(blocked.resets_at)
  const date = new Intl.DateTimeFormat(copy.tag, {
    timeZone: TIME_ZONE,
    month: copy.month,
    day: "numeric",
    weekday: "short",
  })
  const time = new Intl.DateTimeFormat(copy.tag, {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
  return copy.text(
    blocked === quota.weekly ? copy.weekly : copy.monthly,
    `${date.format(resetsAt)} ${time.format(resetsAt)}`,
  )
}

export function locale(value: unknown): Locale {
  return value === "en" ? "en" : "ko"
}

export async function refusal(language: Locale) {
  const quota = await check()
  return quota?.exhausted ? message(quota, language) : undefined
}

export * as CostQuota from "./cost-quota.js"
