import z from "zod"
import { Bus } from "@/bus"
import { NamedError } from "@opencode-ai/util/error"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { getOrCreateMain } from "@/session/ensure"
import type { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import type { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Storage } from "@/storage/storage"
import { Log } from "@/util/log"

// 팀이 최초 기획을 확정하면 rails 가 Plan 프롬프트를 만들어 두고, 앱이 이 pod 에 전달을 부탁한다.
// 같은 확정이 두 번 Plan 으로 가면 안 되므로 rails claim 과 세션 메시지의 표식(+로컬 Storage)으로 막는다.
export namespace InitialPlan {
  const log = Log.create({ service: "enk.initial-plan" })
  const route = "/api/v1/opencode/initial_plan"
  const TIMEOUT_MS = 10_000
  const KEY = ["enk", "initial-plan"]
  const BUILD_KEY = ["enk", "initial-plan-build"]
  export const MARKER = "enkInitialPlan"
  export const BUILD_MARKER = "enkInitialPlanBuild"

  export type State = "delivered" | "already_delivered" | "not_finalized" | "pending_elsewhere"

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

  export const SessionState = z
    .object({
      handoffMessageID: z.string().nullable(),
      planningID: z.string().nullable(),
      buildStarted: z.boolean(),
      lastPlanStatus: z.enum(["running", "done", "error"]).nullable(),
    })
    .meta({ ref: "InitialPlanSessionState" })
  export type SessionState = z.infer<typeof SessionState>

  export const UnavailableError = NamedError.create("InitialPlanUnavailableError", z.object({ message: z.string() }))

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
      const id = part.metadata["planningID"]
      const token = part.metadata["claimToken"]
      return { planningID: id == null ? null : String(id), claimToken: typeof token === "string" ? token : undefined }
    }
  }

  export const find: Deps["find"] = async (planningID) => {
    for (const session of Session.list({ directory: Instance.directory, roots: true })) {
      const msgs = await Session.messages({ sessionID: session.id })
      for (const msg of msgs) {
        const handoff = handoffOf(msg)
        if (handoff?.planningID === planningID) return { sessionID: session.id, claimToken: handoff.claimToken }
      }
    }
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

    const known = current.planning_id == null ? undefined : String(current.planning_id)
    const earlier = known && ((await deps.find(known)) ?? (await stored(known)))
    if (earlier && (await confirm(earlier))) return "already_delivered"

    // 표식은 있는데 토큰을 모르면 점유부터 받아 그 토큰으로 성공을 알린다.

    const claimed = await claim()
    if (!claimed.claimed) {
      if (claimed.status === "delivered") return "already_delivered"
      if (claimed.status === "none") return "not_finalized"
      if (claimed.status === "claimed") return "pending_elsewhere"
      throw new Error(`initial plan is ${claimed.status}`)
    }

    const planningID = String(claimed.planning_id)
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

  const NONE: SessionState = { handoffMessageID: null, planningID: null, buildStarted: false, lastPlanStatus: null }

  async function buildMarked(planningID: string) {
    return Storage.read<{ sessionID: string }>([...BUILD_KEY, planningID]).then(
      () => true,
      () => false,
    )
  }

  function settled(msg: MessageV2.WithParts | undefined) {
    if (!msg || msg.info.role !== "assistant") return false
    return !!msg.info.time.completed && !msg.info.error && !!msg.info.finish && msg.info.finish !== "tool-calls"
  }

  // 메인 세션 전체를 서버에서 훑는다. 앱의 메시지 창(최근 일부)에 기대면 오래된 전달 표식을 놓친다.
  export async function sessionState(sessionID: SessionID): Promise<SessionState> {
    const msgs = await Session.messages({ sessionID })
    const start = msgs.findLastIndex((msg) => !!handoffOf(msg))
    if (start < 0) return NONE
    const planningID = handoffOf(msgs[start])?.planningID ?? null
    const after = msgs.slice(start + 1)
    const buildStarted =
      after.some((msg) => msg.info.role === "user" && msg.info.agent !== "plan") ||
      (planningID !== null && (await buildMarked(planningID)))
    const busy = (await SessionStatus.get(sessionID)).type !== "idle"
    const lastPlanStatus = busy || retrying.has(sessionID) ? "running" : settled(msgs.at(-1)) ? "done" : "error"
    return { handoffMessageID: msgs[start].info.id, planningID, buildStarted, lastPlanStatus }
  }

  const retrying = new Set<string>()

  // 같은 기획으로 Plan 을 다시 돌린다. 전달 메시지를 새로 만들지 않고, 실패한 답만 걷어 내고 루프를 다시 연다.
  export async function retry(sessionID: SessionID) {
    if (retrying.has(sessionID)) return
    const state = await sessionState(sessionID)
    if (!state.handoffMessageID || state.buildStarted || state.lastPlanStatus !== "error")
      throw new UnavailableError({ message: "initial plan retry is not available" })
    retrying.add(sessionID)
    try {
      const msgs = await Session.messages({ sessionID })
      for (const msg of msgs.toReversed()) {
        if (msg.info.role !== "assistant") break
        await Session.removeMessage({ sessionID, messageID: msg.info.id })
      }
    } finally {
      retrying.delete(sessionID)
    }
    loopInBackground(sessionID)
  }

  // 최초 기획 뒤 첫 Build 요청을 만들어도 되는지. 된다면 그 기획의 planningID.
  export async function buildTarget(sessionID: SessionID) {
    const state = await sessionState(sessionID)
    if (!state.handoffMessageID || !state.planningID)
      throw new UnavailableError({ message: "no initial plan in this session" })
    if (state.buildStarted) throw new UnavailableError({ message: "build already started" })
    if (state.lastPlanStatus !== "done") throw new UnavailableError({ message: "plan is not ready" })
    return state.planningID
  }

  const building = new Set<string>()

  // 첫 Build 는 기획당 한 번만 나간다. 표식을 먼저 남기고, 이미 있으면 false.
  export async function claimBuild(planningID: string, sessionID: string) {
    if (building.has(planningID)) return false
    building.add(planningID)
    try {
      if (await buildMarked(planningID)) return false
      await Storage.write([...BUILD_KEY, planningID], { sessionID })
      return true
    } finally {
      building.delete(planningID)
    }
  }

  export function buildPrompt(text: string, planningID: string) {
    return {
      agent: "build",
      parts: [{ type: "text" as const, text, metadata: { [BUILD_MARKER]: planningID } }],
    }
  }

  export function buildPlanningID(parts: { type: string; metadata?: Record<string, unknown> }[]) {
    for (const part of parts) {
      const id = part.type === "text" ? part.metadata?.[BUILD_MARKER] : undefined
      if (typeof id === "string") return id
    }
  }
}
