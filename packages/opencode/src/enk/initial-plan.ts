import z from "zod"
import { Bus } from "@/bus"
import { NamedError } from "@opencode-ai/util/error"
import { Session } from "@/session"
import { getOrCreateMain } from "@/session/ensure"
import { SessionPrompt } from "@/session/prompt"
import { Storage } from "@/storage/storage"
import { Log } from "@/util/log"

// 팀이 최초 기획을 확정하면 rails 가 Plan 프롬프트를 만들어 두고, 앱이 이 pod 에 전달을 부탁한다.
// 같은 확정이 두 번 Plan 으로 가면 안 되므로 rails claim 과 로컬 표식 두 겹으로 막는다.
export namespace InitialPlan {
  const log = Log.create({ service: "enk.initial-plan" })
  const route = "/api/v1/opencode/initial_plan"
  const TIMEOUT_MS = 10_000
  const KEY = ["enk", "initial-plan"]
  export const MARKER = "enkInitialPlan"

  export type State = "delivered" | "already_delivered" | "not_finalized"

  export const Status = z.object({
    status: z.enum(["none", "pending", "claimed", "delivered", "failed"]),
    planning_id: z.union([z.number(), z.string()]).nullish(),
  })
  export type Status = z.infer<typeof Status>

  const Claim = z.union([
    z.object({ claimed: z.literal(true), planning_id: z.union([z.number(), z.string()]), prompt: z.string().min(1) }),
    z.object({ claimed: z.literal(false), status: z.string() }),
  ])
  type Claim = z.infer<typeof Claim>

  type Marker = { planningID: string; sessionID: string }

  export class Unavailable extends Error {}

  export type Send = (prompt: string) => Promise<string>

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

  async function report(result: { status: "delivered"; session_id: string } | { status: "failed"; error: string }) {
    await call("/result", { method: "POST", body: result })
  }

  async function marked(planningID: string) {
    const marker = await Storage.read<Marker>(KEY).catch(() => undefined)
    return marker?.planningID === planningID ? marker : undefined
  }

  // 메인 세션에 Plan 요청을 남기고 곧바로 돌아온다. 답변 생성은 기다리지 않는다 — 앱은 전달 접수만 알면 되고
  // 진행은 세션 화면이 보여준다.
  export const send: Send = async (prompt) => {
    const session = await getOrCreateMain()
    await SessionPrompt.prompt({
      sessionID: session.id,
      agent: "plan",
      noReply: true,
      parts: [{ type: "text", text: prompt, metadata: { [MARKER]: true } }],
    })
    SessionPrompt.loop({ sessionID: session.id }).catch((err) => {
      log.error("initial plan loop failed", { sessionID: session.id, error: err })
      Bus.publish(Session.Event.Error, {
        sessionID: session.id,
        error: new NamedError.Unknown({ message: err instanceof Error ? err.message : String(err) }).toObject(),
      })
    })
    return session.id
  }

  async function run(deliverTo: Send): Promise<State> {
    const current = await status()
    if (current.status === "none") return "not_finalized"
    if (current.status === "delivered") return "already_delivered"

    const sent = current.planning_id == null ? undefined : await marked(String(current.planning_id))
    if (sent) {
      const reported = await report({ status: "delivered", session_id: sent.sessionID }).then(
        () => true,
        (err) => {
          log.warn("initial plan re-report failed, claiming", { err: String(err) })
          return false
        },
      )
      if (reported) return "already_delivered"
    }

    const claimed = await claim()
    if (!claimed.claimed) {
      if (claimed.status === "delivered") return "already_delivered"
      if (claimed.status === "none") return "not_finalized"
      throw new Error(`initial plan is ${claimed.status}`)
    }

    const planningID = String(claimed.planning_id)
    const previous = await marked(planningID)
    if (previous) {
      await report({ status: "delivered", session_id: previous.sessionID })
      return "already_delivered"
    }

    const sessionID = await deliverTo(claimed.prompt).catch(async (err) => {
      const error = err instanceof Error ? err.message : String(err)
      await report({ status: "failed", error }).catch((reportErr) =>
        log.warn("initial plan failure report failed", { err: String(reportErr) }),
      )
      throw err
    })
    await Storage.write(KEY, { planningID, sessionID } satisfies Marker)
    await report({ status: "delivered", session_id: sessionID })
    return "delivered"
  }

  let inflight: Promise<State> | undefined

  export function deliver(deliverTo: Send = send): Promise<State> {
    if (inflight) return inflight
    const task = run(deliverTo).finally(() => {
      inflight = undefined
    })
    inflight = task
    return task
  }
}
