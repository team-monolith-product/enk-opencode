import z from "zod"
import { Bus } from "@/bus"
import { NamedError } from "@opencode-ai/util/error"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { getOrCreateMain } from "@/session/ensure"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import type { SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { Log } from "@/util/log"

// 팀이 최초 기획을 확정하면 rails 가 Plan 프롬프트를 만들어 두고, 앱이 이 pod 에 전달을 부탁한다.
// 같은 확정이 두 번 Plan 으로 가면 안 되므로 rails claim 과 세션 메시지의 표식(+로컬 Storage)으로 막는다.
export namespace InitialPlan {
  const log = Log.create({ service: "enk.initial-plan" })
  const route = "/api/v1/opencode/initial_plan"
  const TIMEOUT_MS = 10_000
  const KEY = ["enk", "initial-plan"]
  export const MARKER = "enkInitialPlan"

  export type State = "delivered" | "already_delivered" | "not_finalized" | "pending_elsewhere" | "failed"

  const PLANNING_ID = /^\d+$/
  const planningOf = (value: unknown) => {
    const id = typeof value === "number" ? String(value) : value
    return typeof id === "string" && PLANNING_ID.test(id) ? id : undefined
  }

  export const Status = z.object({
    status: z.enum(["none", "pending", "claimed", "delivered", "failed"]),
    planning_id: z.union([z.number(), z.string()]).nullish(),
  })
  export type Status = z.infer<typeof Status>

  const Claim = z.union([
    z.object({
      claimed: z.literal(true),
      planning_id: z.union([z.number(), z.string()]),
      claim_token: z.string().min(1),
      prompt: z.string().min(1),
    }),
    z.object({ claimed: z.literal(false), status: z.string() }),
  ])
  type Claim = z.infer<typeof Claim>

  type Marker = { planningID: string; sessionID: string; claimToken?: string }

  const Result = z.object({ status: z.string(), applied: z.boolean() })

  export type Sent = { sessionID: string; claimToken?: string }

  export class Unavailable extends Error {}

  export type Deps = {
    send: (prompt: string, planningID: string, claimToken: string) => Promise<string>
    find: (planningID: string) => Promise<Sent | undefined>
  }

  function backend() {
    const url = process.env["ENK_HACKATHON_RAILS_URL"]
    const token = process.env["ENK_AI_USAGE_TOKEN"]
    if (!url || !token) return
    return { url: url.replace(/\/+$/, "") + route, token }
  }

  async function call(path: string, init?: { method: "POST"; body?: unknown }) {
    const rails = backend()
    if (!rails) throw new Unavailable("rails is not configured")
    const res = await fetch(rails.url + path, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `token ${rails.token}`,
        ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`rails ${init?.method ?? "GET"} ${route}${path} responded ${res.status}`)
    return res.json().catch(() => undefined)
  }

  export async function status(): Promise<Status> {
    return Status.parse(await call(""))
  }

  async function claim(): Promise<Claim> {
    return Claim.parse(await call("/claim", { method: "POST" }))
  }

  // 성공 보고는 어느 점유 토큰으로든 받아 주고, 실패 보고는 지금 점유의 토큰일 때만 반영된다.
  async function delivered(sessionID: string, claimToken: string) {
    const result = Result.parse(
      await call("/result", {
        method: "POST",
        body: { status: "delivered", session_id: sessionID, claim_token: claimToken },
      }),
    )
    if (result.status !== "delivered") throw new Error(`rails kept the initial plan ${result.status}`)
  }

  async function failed(error: string, claimToken: string) {
    const result = Result.parse(
      await call("/result", { method: "POST", body: { status: "failed", error, claim_token: claimToken } }),
    )
    if (!result.applied) log.warn("initial plan failure not applied", { status: result.status })
  }

  async function stored(planningID: string): Promise<Sent | undefined> {
    const marker = await Storage.read<Marker>(KEY).catch(() => undefined)
    if (marker?.planningID !== planningID) return
    return { sessionID: marker.sessionID, claimToken: marker.claimToken }
  }

  function handoffOf(msg: MessageV2.WithParts) {
    if (msg.info.role !== "user") return
    for (const part of msg.parts) {
      if (part.type !== "text" || part.metadata?.[MARKER] !== true) continue
      const token = part.metadata["claimToken"]
      return {
        planningID: planningOf(part.metadata["planningID"]) ?? null,
        claimToken: typeof token === "string" ? token : undefined,
      }
    }
  }

  // 전달 표식은 기획당 한 번만 찾는다. rails 가 pending·failed 로 머무는 동안 매 요청마다 세션 전체를 훑지 않게.
  const found = new Map<string, Sent | null>()
  const foundKey = (planningID: string) => `${Instance.directory}\0${planningID}`

  export const find: Deps["find"] = async (planningID) => {
    const key = foundKey(planningID)
    const cached = found.get(key)
    if (cached !== undefined) return cached ?? undefined
    let result: Sent | null = null
    for (const session of Session.list({ directory: Instance.directory, roots: true })) {
      for await (const msg of MessageV2.stream(session.id)) {
        const handoff = handoffOf(msg)
        if (handoff?.planningID !== planningID) continue
        result = { sessionID: session.id, claimToken: handoff.claimToken }
        break
      }
      if (result) break
    }
    found.set(key, result)
    return result ?? undefined
  }

  function loopInBackground(sessionID: SessionID) {
    SessionPrompt.loop({ sessionID }).catch((err) => {
      log.error("initial plan loop failed", { sessionID, error: err })
      Bus.publish(Session.Event.Error, {
        sessionID,
        error: new NamedError.Unknown({ message: err instanceof Error ? err.message : String(err) }).toObject(),
      })
    })
  }

  // 메인 세션에 Plan 요청을 남기고 곧바로 돌아온다. 답변 생성은 기다리지 않는다.
  export const send: Deps["send"] = async (prompt, planningID, claimToken) => {
    const session = await getOrCreateMain()
    await SessionPrompt.prompt({
      sessionID: session.id,
      agent: "plan",
      noReply: true,
      parts: [{ type: "text", text: prompt, metadata: { [MARKER]: true, planningID, claimToken } }],
    })
    found.set(foundKey(planningID), { sessionID: session.id, claimToken })
    loopInBackground(session.id)
    return session.id
  }

  async function confirm(sent: Sent) {
    if (!sent.claimToken) return false
    return delivered(sent.sessionID, sent.claimToken).then(
      () => true,
      (err) => {
        log.warn("initial plan re-report failed", { err: String(err) })
        return false
      },
    )
  }

  async function run(deps: Deps): Promise<State> {
    const current = await status()
    if (current.status === "none") return "not_finalized"
    if (current.status === "delivered") return "already_delivered"

    const known = planningOf(current.planning_id)
    const earlier = known && ((await deps.find(known)) ?? (await stored(known)))
    if (earlier && (await confirm(earlier))) return "already_delivered"

    // 표식은 있는데 토큰을 모르면 점유부터 받아 그 토큰으로 성공을 알린다.

    const claimed = await claim()
    if (!claimed.claimed) {
      if (claimed.status === "delivered") return "already_delivered"
      if (claimed.status === "none") return "not_finalized"
      if (claimed.status === "claimed") return "pending_elsewhere"
      if (claimed.status === "failed") return "failed"
      throw new Error(`initial plan is ${claimed.status}`)
    }

    const planningID = planningOf(claimed.planning_id)
    if (!planningID) throw new Error("rails answered an invalid planning id")
    const claimToken = claimed.claim_token
    const previous = (await deps.find(planningID)) ?? (await stored(planningID))
    if (previous) {
      await delivered(previous.sessionID, claimToken)
      return "already_delivered"
    }

    const sessionID = await deps.send(claimed.prompt, planningID, claimToken).catch(async (err) => {
      const error = err instanceof Error ? err.message : String(err)
      await failed(error, claimToken).catch((reportErr) =>
        log.warn("initial plan failure report failed", { err: String(reportErr) }),
      )
      throw err
    })
    await Storage.write(KEY, { planningID, sessionID, claimToken } satisfies Marker)
    await delivered(sessionID, claimToken)
    return "delivered"
  }

  let inflight: Promise<State> | undefined

  export function deliver(deps: Partial<Deps> = {}): Promise<State> {
    if (inflight) return inflight
    const task = run({ send, find, ...deps }).finally(() => {
      inflight = undefined
    })
    inflight = task
    return task
  }
}
