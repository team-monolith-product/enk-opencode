import { Database, eq } from "@/storage/db"
import { Flag } from "@/flag/flag"
import { ImageQuotaTable } from "./image-quota.sql"

// 팀당 이미지 생성 한도는 rails 가 센다. 비용이 한도를 넘지 않도록 rails 에 닿지 못하면 생성하지 않는다.
// 화면 표시는 DB 캐시(한도는 hub 가 주입한 값 우선)로 바로 답하고, rails 응답이 올 때마다 캐시를 고친다.
export namespace ImageQuota {
  const route = "/api/v1/opencode/image_generations"
  const TIMEOUT_MS = 15_000

  export type Quota = { limit: number; used: number; remaining: number }

  export type Reservation =
    | { status: "reserved"; quota?: Quota }
    | { status: "exhausted"; quota: Quota }
    | { status: "unavailable" }

  const ROW = "team"
  let synced = false
  let unavailable = false

  function save(quota: Quota) {
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
  }

  function remember(quota: Quota | undefined) {
    if (!quota) return
    try {
      save(quota)
    } catch {}
  }

  export function reset() {
    synced = false
    unavailable = false
    Database.use((db) => db.delete(ImageQuotaTable).run())
  }

  // null: 이 작업 공간에서는 쓸 수 없음. undefined: 아직 알 수 없음(또는 rails 없는 로컬).
  export function cached(): Quota | null | undefined {
    if (!synced) {
      synced = true
      void status().catch(() => undefined)
    }
    if (unavailable) return null
    const row = Database.use((db) => db.select().from(ImageQuotaTable).where(eq(ImageQuotaTable.id, ROW)).get())
    const limit = Flag.ENK_IMAGE_GENERATION_LIMIT ?? row?.limit
    if (limit === undefined) return
    const used = row?.used ?? 0
    return { limit, used, remaining: Math.max(limit - used, 0) }
  }

  function backend() {
    const url = process.env["ENK_HACKATHON_RAILS_URL"]
    const token = process.env["ENK_AI_USAGE_TOKEN"]
    if (!url || !token) return
    return { url: url.replace(/\/+$/, "") + route, token }
  }

  export async function reserve(callID: string): Promise<Reservation> {
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
    const quota = (await res.json().catch(() => undefined)) as Quota | undefined
    if (res.status === 409 && quota) {
      remember(quota)
      return { status: "exhausted", quota }
    }
    if (!res.ok) throw new Error(`이미지 생성 가능 개수를 확인하지 못했습니다 (${res.status}).`)
    remember(quota)
    return { status: "reserved", quota }
  }

  // 팀 작업 공간이 아니면 null, rails 설정이 없는 로컬이면 undefined(제한 없음).
  export async function status(): Promise<Quota | null | undefined> {
    const rails = backend()
    if (!rails) return
    const res = await fetch(rails.url, {
      headers: { Authorization: `token ${rails.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.status === 403) {
      unavailable = true
      return null
    }
    if (!res.ok) throw new Error(`image quota ${res.status}`)
    const quota = (await res.json()) as Quota
    remember(quota)
    return quota
  }

  export async function release(callID: string) {
    const rails = backend()
    if (!rails) return
    const res = await fetch(`${rails.url}/${encodeURIComponent(callID)}`, {
      method: "DELETE",
      headers: { Authorization: `token ${rails.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => undefined)
    if (res?.ok) remember((await res.json().catch(() => undefined)) as Quota | undefined)
  }
}
