import type { Plugin } from "@opencode/plugin"
import * as Definitions from "./rpc"
import { Session } from "./session"

// 팀이 최초 기획을 확정하면 rails 가 Plan 프롬프트를 만들어 두고, 앱이 이 pod 에 전달을 부탁한다(V1 enk/initial-plan.ts).
// 같은 확정이 두 번 Plan 으로 가면 안 되므로 rails claim 과 사용자 메시지 metadata 의 표식(+플러그인 저장소)으로 막는다.

type Context = Plugin.Context

const ROUTE = "/api/v1/opencode/initial_plan"
const TIMEOUT_MS = 10_000
const KEY = "initial-plan"
const PAGE = 50
export const MARKER = "enkInitialPlan"
export const AGENT = "plan"

export type State = "delivered" | "already_delivered" | "not_finalized" | "pending_elsewhere" | "failed"

export type Sent = { sessionID: string; claimToken?: string }

export type Marker = { planningID: string; sessionID: string; claimToken?: string }

export class Unavailable extends Error {}

export type Deps = {
  send: (prompt: string, planningID: string, claimToken: string) => Promise<string>
  find: (planningID: string) => Promise<Sent | undefined>
  stored: (planningID: string) => Promise<Sent | undefined>
  record: (marker: Marker) => Promise<void>
}

const PLANNING_ID = /^\d+$/
export const planningOf = (value: unknown) => {
  const id = typeof value === "number" ? String(value) : value
  return typeof id === "string" && PLANNING_ID.test(id) ? id : undefined
}

type Status = { status: "none" | "pending" | "claimed" | "delivered" | "failed"; planning_id?: unknown }
type Claim =
  | { claimed: true; planning_id: unknown; claim_token: string; prompt: string }
  | { claimed: false; status: string }

const STATUSES = new Set(["none", "pending", "claimed", "delivered", "failed"])
const record = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : {})
const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined)

function backend(env: NodeJS.ProcessEnv = process.env) {
  const url = env.ENK_HACKATHON_RAILS_URL
  const token = env.ENK_AI_USAGE_TOKEN
  if (!url || !token) return
  return { url: url.replace(/\/+$/, "") + ROUTE, token }
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
  if (!res.ok) throw new Error(`rails ${init?.method ?? "GET"} ${ROUTE}${path} responded ${res.status}`)
  return res.json().catch(() => undefined)
}

export async function status(): Promise<Status> {
  const value = record(await call(""))
  if (typeof value.status !== "string" || !STATUSES.has(value.status))
    throw new Error("rails answered an invalid initial plan status")
  return { status: value.status as Status["status"], planning_id: value.planning_id }
}

async function claim(): Promise<Claim> {
  const value = record(await call("/claim", { method: "POST" }))
  if (value.claimed === false && typeof value.status === "string") return { claimed: false, status: value.status }
  const token = text(value.claim_token)
  const prompt = text(value.prompt)
  if (value.claimed !== true || !token || !prompt) throw new Error("rails answered an invalid initial plan claim")
  return { claimed: true, planning_id: value.planning_id, claim_token: token, prompt }
}

async function result(body: Record<string, unknown>) {
  const value = record(await call("/result", { method: "POST", body }))
  if (typeof value.status !== "string" || typeof value.applied !== "boolean")
    throw new Error("rails answered an invalid initial plan result")
  return { status: value.status, applied: value.applied }
}

// 성공 보고는 어느 점유 토큰으로든 받아 주고, 실패 보고는 지금 점유의 토큰일 때만 반영된다.
async function delivered(sessionID: string, claimToken: string) {
  const answer = await result({ status: "delivered", session_id: sessionID, claim_token: claimToken })
  if (answer.status !== "delivered") throw new Error(`rails kept the initial plan ${answer.status}`)
}

async function failed(error: string, claimToken: string) {
  const answer = await result({ status: "failed", error, claim_token: claimToken })
  if (!answer.applied) console.warn("[jitda.initial-plan] failure not applied", answer.status)
}

async function confirm(sent: Sent) {
  if (!sent.claimToken) return false
  return delivered(sent.sessionID, sent.claimToken).then(
    () => true,
    (err) => {
      console.warn("[jitda.initial-plan] re-report failed", String(err))
      return false
    },
  )
}

async function run(deps: Deps): Promise<State> {
  const current = await status()
  if (current.status === "none") return "not_finalized"
  if (current.status === "delivered") return "already_delivered"

  const known = planningOf(current.planning_id)
  const earlier = known && ((await deps.find(known)) ?? (await deps.stored(known)))
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
  const previous = (await deps.find(planningID)) ?? (await deps.stored(planningID))
  if (previous) {
    await delivered(previous.sessionID, claimToken)
    return "already_delivered"
  }

  const sessionID = await deps.send(claimed.prompt, planningID, claimToken).catch(async (err) => {
    const error = err instanceof Error ? err.message : String(err)
    await failed(error, claimToken).catch((reportErr) =>
      console.warn("[jitda.initial-plan] failure report failed", String(reportErr)),
    )
    throw err
  })
  await deps.record({ planningID, sessionID, claimToken })
  await delivered(sessionID, claimToken)
  return "delivered"
}

export function createDelivery(deps: Deps) {
  let inflight: Promise<State> | undefined
  return {
    deliver(): Promise<State> {
      if (inflight) return inflight
      const task = run(deps).finally(() => {
        inflight = undefined
      })
      inflight = task
      return task
    },
  }
}

type Message = { type: string; metadata?: Record<string, unknown> }

export function handoffOf(message: Message) {
  if (message.type !== "user" || message.metadata?.[MARKER] !== true) return
  return {
    planningID: planningOf(message.metadata.planningID) ?? null,
    claimToken: text(message.metadata.claimToken),
  }
}

// 전달 표식은 기획당 한 번만 찾는다. rails 가 pending·failed 로 머무는 동안 매 요청마다 세션 전체를 훑지 않게.
export function createFinder(api: {
  roots: () => Promise<string[]>
  messages: (sessionID: string) => Promise<Message[]>
}) {
  const found = new Map<string, Sent | null>()
  return {
    async find(planningID: string): Promise<Sent | undefined> {
      const cached = found.get(planningID)
      if (cached !== undefined) return cached ?? undefined
      let result: Sent | null = null
      for (const sessionID of await api.roots()) {
        const messages = await api.messages(sessionID).catch(() => [])
        const handoff = messages.map(handoffOf).find((item) => item?.planningID === planningID)
        if (!handoff) continue
        result = { sessionID, claimToken: handoff.claimToken }
        break
      }
      found.set(planningID, result)
      return result ?? undefined
    },
    remember(planningID: string, sent: Sent) {
      found.set(planningID, sent)
    },
  }
}

export type Response = { state: State } | { error: string; unavailable?: true }

export const Rpc = Definitions.InitialPlan

export async function start(ctx: Context) {
  const directory = ctx.location.directory
  const finder = createFinder({
    roots: async () => {
      const ids: string[] = []
      let cursor: string | undefined
      do {
        const page = (await ctx.session.list({
          parentID: null,
          directory,
          limit: PAGE,
          ...(cursor ? { cursor } : {}),
        })) as unknown as { data: Array<{ id: string; location: { directory: string } }>; cursor?: { next?: string } }
        for (const session of page.data) if (session.location.directory === directory) ids.push(session.id)
        cursor = page.cursor?.next
      } while (cursor)
      return ids
    },
    messages: async (sessionID) => (await ctx.session.context({ sessionID })) as unknown as Message[],
  })

  const stored = async (planningID: string): Promise<Sent | undefined> => {
    const marker = (await ctx.storage.get(KEY).catch(() => undefined)) as Marker | undefined
    if (marker?.planningID !== planningID) return
    return { sessionID: marker.sessionID, claimToken: marker.claimToken }
  }

  // 메인 세션을 Plan 으로 돌리고 표식 붙은 요청을 남긴 뒤 곧바로 돌아온다. 답변 생성은 기다리지 않는다.
  const send: Deps["send"] = async (prompt, planningID, claimToken) => {
    const session = await Session.mainOf(ctx).main()
    await ctx.session.switchAgent({ sessionID: session.id, agent: AGENT })
    await ctx.session.prompt({
      sessionID: session.id,
      text: prompt,
      metadata: { [MARKER]: true, planningID, claimToken },
    })
    finder.remember(planningID, { sessionID: session.id, claimToken })
    return session.id
  }

  const delivery = createDelivery({
    send,
    find: finder.find,
    stored,
    record: (marker) => ctx.storage.set(KEY, marker),
  })

  const registration = await ctx.rpc.register(Rpc, {
    deliver: async (): Promise<Response> =>
      delivery.deliver().then(
        (state) => ({ state }),
        (err) => {
          const error = err instanceof Error ? err.message : String(err)
          console.warn("[jitda.initial-plan] delivery failed", error)
          return err instanceof Unavailable ? { error, unavailable: true } : { error }
        },
      ),
  })
  return () => registration.dispose()
}

export * as InitialPlan from "./initial-plan"
