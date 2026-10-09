import z from "zod"
import { Log } from "@/util/log"
import { Locale } from "./locale"

// 팀당 주·월 AI 비용 한도(달러)는 rails 가 센다(hackathons.weekly_cost_limit / monthly_cost_limit). 모델을 부르기 전에
// 남은 양을 묻고, 바닥나면 턴을 시작하지 않는다. rails 에 닿지 못하면 막지 않는다 — 한도는 비용 가드지만 채팅은
// 제품의 전부라, 잠깐의 장애로 해커톤 전체를 세우지 않는다.
export namespace CostQuota {
  const log = Log.create({ service: "enk.cost-quota" })
  const route = "/api/v1/opencode/cost_quota"
  const TIMEOUT_MS = 5_000
  // 매 스텝마다 rails 를 치지 않도록 응답을 잠시 들고 간다. 그 사이 pod 안의 소비는 consume() 이 로컬로 깎고,
  // 실패했을 때도 같은 시간만큼 기다렸다가 다시 묻는다(장애 중 스텝마다 타임아웃을 물지 않게).
  const CACHE_TTL_MS = 30_000
  const TIME_ZONE = "Asia/Seoul"

  // rails 응답 중 pod 가 읽는 부분. 창이 있다는 것 자체가 "지금 강제 중"이다. 한도 금액은 참가자에게 보이면
  // 안 되므로 읽지 않는다 — 남은 양(달러)은 로컬 차감에만 쓰고 안내문에는 창과 초기화 시각만 적는다.
  export const Window = z.object({ remaining: z.number(), resets_at: z.string() })
  export type Window = z.infer<typeof Window>
  export const Quota = z.object({ exhausted: z.boolean(), weekly: Window.nullable(), monthly: Window.nullable() })
  export type Quota = z.infer<typeof Quota>

  const NONE: Quota = { exhausted: false, weekly: null, monthly: null }

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

  // 지금 적용되는 한도. rails 설정이 없는 로컬은 undefined(제한 없음). 팀 토큰이 아니면 rails 가 403 을 주므로
  // 창 없는 quota 로 본다. 막을지는 호출자가 `exhausted` 로 읽는다.
  export async function check(now = Date.now()): Promise<Quota | undefined> {
    const rails = backend()
    if (!rails) return
    if (!cache || now - cache.at >= CACHE_TTL_MS) {
      cache = { quota: (await fetchQuota(rails)) ?? cache?.quota ?? NONE, at: now }
    }
    return cache.quota
  }

  async function fetchQuota(rails: { url: string; token: string }): Promise<Quota | undefined> {
    const res = await fetch(rails.url, {
      headers: { Authorization: `token ${rails.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch((err) => {
      log.warn("cost quota unreachable, allowing", { err: String(err) })
      return undefined
    })
    if (!res) return
    if (res.status === 403) return NONE
    if (!res.ok) {
      log.warn("cost quota request failed, allowing", { status: res.status })
      return
    }
    const parsed = Quota.safeParse(await res.json().catch(() => undefined))
    if (!parsed.success) {
      log.warn("cost quota malformed, allowing")
      return
    }
    return parsed.data
  }

  // 한 스텝의 비용(달러)을 깎은 새 quota. rails 적재는 큐를 타서 늦게 반영되므로 pod 안의 소비는 즉시 반영해야
  // 같은 턴 안에서도 한도를 지킨다. 다음 재조회 때 rails 값으로 덮인다. 부동소수 잔여로 0 에 못 닿는 일이 없게
  // rails cost 컬럼과 같은 소수 8자리로 반올림한다.
  export function spend(quota: Quota, cost: number): Quota {
    const spent = (window: Window | null) =>
      window && { ...window, remaining: Math.max(Number((window.remaining - cost).toFixed(8)), 0) }
    const weekly = spent(quota.weekly)
    const monthly = spent(quota.monthly)
    return { exhausted: [weekly, monthly].some((window) => window !== null && window.remaining <= 0), weekly, monthly }
  }

  export function consume(cost: number) {
    if (!cache || cost <= 0) return
    cache = { ...cache, quota: spend(cache.quota, cost) }
  }

  // 바닥난 창 중 가장 늦게 열리는 창을 안내한다 — 주간이 먼저 풀려도 월간이 막혀 있으면 그때까지 못 쓴다.
  function blocking(quota: Quota) {
    return [quota.weekly, quota.monthly]
      .filter((window): window is Window => window !== null && window.remaining <= 0)
      .sort((a, b) => Date.parse(b.resets_at) - Date.parse(a.resets_at))[0]
  }

  type Copy = {
    tag: string
    month: Intl.DateTimeFormatOptions["month"]
    weekly: string
    monthly: string
    text: (label: string, at: string) => string
  }

  const COPY: Record<Locale.Value, Copy> = {
    ko: {
      tag: "ko-KR",
      month: "long",
      weekly: "이번 주",
      monthly: "이번 달",
      text: (label, at) => `${label} AI 사용 한도를 모두 사용했습니다. ${at}에 다시 사용할 수 있어요.`,
    },
    en: {
      tag: "en-US",
      month: "short",
      weekly: "This week's",
      monthly: "This month's",
      text: (label, at) => `${label} AI usage limit has been used up. It resets on ${at} (KST).`,
    },
  }

  export function message(quota: Quota, locale: Locale.Value = Locale.DEFAULT) {
    const window = blocking(quota)
    if (!window) return ""
    const copy = COPY[locale]
    const at = new Intl.DateTimeFormat(copy.tag, {
      timeZone: TIME_ZONE,
      month: copy.month,
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(window.resets_at))
    return copy.text(window === quota.weekly ? copy.weekly : copy.monthly, at)
  }
}
