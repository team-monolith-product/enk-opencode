import { Log } from "@/util/log"
import type { Locale } from "./locale"

// 팀당 주·월 AI 토큰 한도는 rails 가 센다(hackathons.weekly_token_limit / monthly_token_limit). 모델을 부르기 전에
// 남은 양을 묻고, 바닥나면 턴을 시작하지 않는다. rails 에 닿지 못하면 막지 않는다 — 한도는 비용 가드지만 채팅은
// 제품의 전부라, 잠깐의 장애로 해커톤 전체를 세우지 않는다.
export namespace TokenQuota {
  const log = Log.create({ service: "enk.token-quota" })
  const route = "/api/v1/opencode/token_quota"
  const TIMEOUT_MS = 5_000
  // 매 스텝마다 rails 를 치지 않도록 응답을 잠시 들고 간다. 그 사이 pod 안의 소비는 consume() 이 로컬로 깎고,
  // 실패했을 때도 같은 시간만큼 기다렸다가 다시 묻는다(장애 중 스텝마다 타임아웃을 물지 않게).
  const CACHE_TTL_MS = 30_000
  const TIME_ZONE = "Asia/Seoul"

  export type Window = { limit: number; used: number; remaining: number; resets_at: string }
  export type Quota = { active: boolean; exhausted: boolean; weekly: Window | null; monthly: Window | null }
  export type Verdict = { status: "allowed" } | { status: "blocked"; quota: Quota }

  const INACTIVE: Quota = { active: false, exhausted: false, weekly: null, monthly: null }

  let cache: { quota: Quota; at: number } | undefined

  function backend() {
    const url = process.env["ENK_HACKATHON_RAILS_URL"]
    const token = process.env["ENK_AI_USAGE_TOKEN"]
    if (!url || !token) return
    return { url: url.replace(/\/+$/, "") + route, token }
  }

  export function reset() {
    cache = undefined
  }

  export function windows(quota: Quota) {
    return [quota.weekly, quota.monthly].filter((window): window is Window => window !== null)
  }

  export function exhausted(quota: Quota) {
    return windows(quota).some((window) => window.remaining <= 0)
  }

  export function verdict(quota: Quota): Verdict {
    if (quota.active && exhausted(quota)) return { status: "blocked", quota }
    return { status: "allowed" }
  }

  // 로컬이거나 팀 작업 공간이 아니면 제한 없음. 팀 토큰이 아니면 rails 가 403 을 주므로 같은 취급이다.
  export async function check(now = Date.now()): Promise<Verdict> {
    const rails = backend()
    if (!rails) return { status: "allowed" }
    if (!cache || now - cache.at >= CACHE_TTL_MS) {
      const fetched = await fetchQuota(rails)
      cache = { quota: fetched ?? cache?.quota ?? INACTIVE, at: now }
    }
    return verdict(cache.quota)
  }

  async function fetchQuota(rails: { url: string; token: string }): Promise<Quota | undefined> {
    const res = await fetch(rails.url, {
      headers: { Authorization: `token ${rails.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch((err) => {
      log.warn("token quota unreachable, allowing", { err: String(err) })
      return undefined
    })
    if (!res) return
    if (res.status === 403) return INACTIVE
    if (!res.ok) {
      log.warn("token quota request failed, allowing", { status: res.status })
      return
    }
    const quota = (await res.json().catch(() => undefined)) as Quota | undefined
    if (!quota || typeof quota.active !== "boolean") {
      log.warn("token quota malformed, allowing")
      return
    }
    return quota
  }

  // 한 스텝의 토큰을 캐시에서 바로 깎는다. rails 적재는 큐를 타서 늦게 반영되므로 pod 안의 소비는 즉시 반영해야
  // 같은 턴 안에서도 한도를 지킨다. 다음 재조회 때 rails 값으로 덮인다.
  export function consume(tokens: number) {
    if (!cache || tokens <= 0) return
    for (const window of windows(cache.quota)) {
      window.used += tokens
      window.remaining = Math.max(window.limit - window.used, 0)
    }
    cache.quota.exhausted = cache.quota.active && exhausted(cache.quota)
  }

  export function consumeStep(tokens: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }) {
    consume(
      (tokens.input ?? 0) +
        (tokens.output ?? 0) +
        (tokens.reasoning ?? 0) +
        (tokens.cache?.read ?? 0) +
        (tokens.cache?.write ?? 0),
    )
  }

  // 바닥난 창 중 가장 늦게 열리는 창을 안내한다 — 주간이 먼저 풀려도 월간이 막혀 있으면 그때까지 못 쓴다.
  export function blocking(quota: Quota) {
    const candidates = windows(quota).filter((window) => window.remaining <= 0)
    return candidates.sort((a, b) => Date.parse(b.resets_at) - Date.parse(a.resets_at))[0]
  }

  export function message(quota: Quota, locale?: Locale.Value) {
    const window = blocking(quota)
    if (!window) return ""
    const period = window === quota.weekly ? "weekly" : "monthly"
    const limit = window.limit.toLocaleString("en-US")
    if (locale === "en") {
      const at = new Intl.DateTimeFormat("en-US", {
        timeZone: TIME_ZONE,
        month: "short",
        day: "numeric",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(window.resets_at))
      const label = period === "weekly" ? "This week's" : "This month's"
      return `${label} AI token limit (${limit}) has been used up. It resets at ${at} (KST).`
    }
    const at = new Intl.DateTimeFormat("ko-KR", {
      timeZone: TIME_ZONE,
      month: "long",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(window.resets_at))
    const label = period === "weekly" ? "이번 주" : "이번 달"
    return `${label} AI 토큰 한도(${limit})를 모두 사용했습니다. ${at}에 다시 사용할 수 있어요.`
  }
}
