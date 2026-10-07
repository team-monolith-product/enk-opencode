import { Database, eq } from "@/storage/db"
import { Flag } from "@/flag/flag"
import { ImageQuotaTable } from "./image-quota.sql"

// 팀당 이미지 생성 한도는 rails 가 센다. 비용이 한도를 넘지 않도록 rails 에 닿지 못하면 생성하지 않는다.
// 한도는 hub 가 spawn 때 주입한 값만 쓰고 rails 에 묻지 않는다. 사용 개수는 예약·반납 응답으로 DB 에 남긴다.
// 튜토리얼과 본행사는 따로 세므로 사용 개수도 rails 가 알려준 구간(phase)별 행에 남긴다.
export namespace ImageQuota {
  const route = "/api/v1/opencode/image_generations"
  const TIMEOUT_MS = 15_000
  const ROW = "team"

  export type Quota = { limit: number; used: number; remaining: number; phase?: string }

  export type State =
    | { kind: "unlimited" } // rails 가 없는 로컬 개발
    | { kind: "unavailable" } // 한도가 주입되지 않은 pod(팀 작업 공간이 아님 등)
    | { kind: "disabled" } // 한도 0: 이 해커톤에서는 이미지 생성을 쓰지 않는다
    | { kind: "known"; quota: Quota }

  export type Reservation =
    | { status: "reserved"; quota?: Quota }
    | { status: "exhausted"; quota: Quota }
    | { status: "unavailable" }

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
          .values({ id: quota.phase ?? ROW, limit: quota.limit, used: quota.used, time_updated: Date.now() })
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
    const limit = Flag.ENK_IMAGE_GENERATION_LIMIT
    if (limit === undefined) return { kind: "unavailable" }
    if (limit === 0) return { kind: "disabled" }
    const id = Flag.ENK_IMAGE_GENERATION_PHASE ?? ROW
    const row = Database.use((db) => db.select().from(ImageQuotaTable).where(eq(ImageQuotaTable.id, id)).get())
    const used = row?.used ?? 0
    return { kind: "known", quota: { limit, used, remaining: Math.max(limit - used, 0) } }
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
    if (res.status === 403) return { status: "unavailable" }
    const quota = await body(res)
    if (quota) save(quota)
    if (res.status === 409 && quota) return { status: "exhausted", quota }
    if (!res.ok) throw new Error(`이미지 생성 가능 개수를 확인하지 못했습니다 (${res.status}).`)
    return { status: "reserved", quota }
  }

  // 그림을 썼으면 확정(PATCH)하고 아니면 반납(DELETE)한다. 확정되지 않은 예약은 rails 가 일정 시간 뒤 개수에서 뺀다
  // (반납 실패·pod 재시작·응답 유실로 한도가 영구히 새지 않게).
  async function settle(callID: string, method: "PATCH" | "DELETE") {
    const rails = backend()
    if (!rails) return
    const res = await fetch(`${rails.url}/${encodeURIComponent(callID)}`, {
      method,
      headers: { Authorization: `token ${rails.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => undefined)
    const quota = res?.ok ? await body(res) : undefined
    if (quota) save(quota)
  }

  /**
   * 한 장을 예약하고 run 을 실행한다. kept 면 확정하고, run 이 던지거나 kept 가 아니면 반납해 개수에서 뺀다.
   * 예약하지 못하면 run 을 부르지 않는다.
   */
  export async function withReservation<T>(
    callID: string,
    run: (quota: Quota | undefined) => Promise<{ kept: boolean; value: T }>,
  ): Promise<Exclude<Reservation, { status: "reserved" }> | { status: "reserved"; value: T }> {
    const reservation = await reserve(callID)
    if (reservation.status !== "reserved") return reservation
    const result = await run(reservation.quota).catch(async (err) => {
      await settle(callID, "DELETE")
      throw err
    })
    await settle(callID, result.kept ? "PATCH" : "DELETE")
    return { status: "reserved", value: result.value }
  }

  export function reset() {
    Database.use((db) => db.delete(ImageQuotaTable).run())
  }
}
