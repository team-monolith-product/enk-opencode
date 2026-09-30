import { Database, eq } from "@/storage/db"
import { Flag } from "@/flag/flag"
import { ImageQuotaTable } from "./image-quota.sql"

// 팀당 이미지 생성 한도는 rails 가 센다. 비용이 한도를 넘지 않도록 rails 에 닿지 못하면 생성하지 않는다.
// 화면 표시는 DB 캐시(한도는 hub 가 주입한 값 우선)로 바로 답하고, rails 응답이 올 때마다 캐시를 고친다.
export namespace ImageQuota {
  const route = "/api/v1/opencode/image_generations"
  const TIMEOUT_MS = 15_000
  const ROW = "team"

  export type Quota = { limit: number; used: number; remaining: number }

  export type State =
    | { kind: "unlimited" } // rails 가 없는 로컬 개발
    | { kind: "unavailable" } // 팀 작업 공간이 아님
    | { kind: "unknown" } // 아직 rails 와 맞추기 전
    | { kind: "known"; quota: Quota }

  export type Reservation =
    | { status: "reserved"; quota?: Quota }
    | { status: "exhausted"; quota: Quota }
    | { status: "unavailable" }

  let unavailable = false
  let syncing: Promise<unknown> | undefined

  function backend() {
    const url = process.env["ENK_HACKATHON_RAILS_URL"]
    const token = process.env["ENK_AI_USAGE_TOKEN"]
    if (!url || !token) return
    return { url: url.replace(/\/+$/, "") + route, token }
  }

  function save(quota: Quota) {
    try {
      Database.use((db) =>
        db
          .insert(ImageQuotaTable)
          .values({ id: ROW, limit: quota.limit, used: quota.used, time_updated: Date.now() })
          .onConflictDoUpdate({
            target: ImageQuotaTable.id,
            set: { limit: quota.limit, used: quota.used, time_updated: Date.now() },
          })
          .run(),
      )
    } catch {}
  }

  async function body(res: Response) {
    return (await res.json().catch(() => undefined)) as Quota | undefined
  }

  export function state(): State {
    if (!backend()) return { kind: "unlimited" }
    if (unavailable) return { kind: "unavailable" }
    const row = Database.use((db) => db.select().from(ImageQuotaTable).where(eq(ImageQuotaTable.id, ROW)).get())
    const limit = Flag.ENK_IMAGE_GENERATION_LIMIT ?? row?.limit
    if (limit === undefined) return { kind: "unknown" }
    const used = row?.used ?? 0
    return { kind: "known", quota: { limit, used, remaining: Math.max(limit - used, 0) } }
  }

  /** 부팅 때 한 번 rails 와 캐시를 맞춘다. 화면을 기다리게 하지 않도록 결과를 기다리지 않는다. */
  export function init() {
    syncing ??= sync().catch(() => undefined)
  }

  export async function sync(): Promise<State> {
    const rails = backend()
    if (!rails) return state()
    const res = await fetch(rails.url, {
      headers: { Authorization: `token ${rails.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.status === 403) unavailable = true
    else if (!res.ok) throw new Error(`image quota ${res.status}`)
    else {
      const quota = await body(res)
      if (quota) save(quota)
    }
    return state()
  }

  async function reserve(callID: string): Promise<Reservation> {
    const rails = backend()
    if (!rails) return { status: "reserved" }
    const res = await fetch(rails.url, {
      method: "POST",
      headers: { Authorization: `token ${rails.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ call_id: callID }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => undefined)
    if (!res) throw new Error("이미지 생성 가능 개수를 확인하지 못했습니다. 잠시 후 다시 시도하세요.")
    if (res.status === 403) {
      unavailable = true
      return { status: "unavailable" }
    }
    const quota = await body(res)
    if (quota) save(quota)
    if (res.status === 409 && quota) return { status: "exhausted", quota }
    if (!res.ok) throw new Error(`이미지 생성 가능 개수를 확인하지 못했습니다 (${res.status}).`)
    return { status: "reserved", quota }
  }

  async function release(callID: string) {
    const rails = backend()
    if (!rails) return
    const res = await fetch(`${rails.url}/${encodeURIComponent(callID)}`, {
      method: "DELETE",
      headers: { Authorization: `token ${rails.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => undefined)
    const quota = res?.ok ? await body(res) : undefined
    if (quota) save(quota)
  }

  /**
   * 한 장을 예약하고 run 을 실행한다. run 이 던지거나 kept 가 아닌 결과를 돌려주면 예약을 반납해
   * 개수에서 빠지게 한다. 예약하지 못하면 run 을 부르지 않는다.
   */
  export async function withReservation<T>(
    callID: string,
    run: (quota: Quota | undefined) => Promise<{ kept: boolean; value: T }>,
  ): Promise<Exclude<Reservation, { status: "reserved" }> | { status: "reserved"; value: T }> {
    const reservation = await reserve(callID)
    if (reservation.status !== "reserved") return reservation
    const result = await run(reservation.quota).catch(async (err) => {
      await release(callID)
      throw err
    })
    if (!result.kept) await release(callID)
    return { status: "reserved", value: result.value }
  }

  export function reset() {
    unavailable = false
    syncing = undefined
    Database.use((db) => db.delete(ImageQuotaTable).run())
  }
}
