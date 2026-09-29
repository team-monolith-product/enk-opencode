// 팀당 이미지 생성 한도는 rails 가 센다. 비용이 한도를 넘지 않도록 rails 에 닿지 못하면 생성하지 않는다.
export namespace ImageQuota {
  const route = "/api/v1/opencode/image_generations"
  const TIMEOUT_MS = 15_000

  export type Quota = { limit: number; used: number; remaining: number }

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
    if (res.status === 409 && quota) return { status: "exhausted", quota }
    if (!res.ok) throw new Error(`이미지 생성 가능 개수를 확인하지 못했습니다 (${res.status}).`)
    return { status: "reserved", quota }
  }

  export async function release(callID: string) {
    const rails = backend()
    if (!rails) return
    await fetch(`${rails.url}/${encodeURIComponent(callID)}`, {
      method: "DELETE",
      headers: { Authorization: `token ${rails.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => undefined)
  }
}
