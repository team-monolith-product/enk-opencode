import { apiUrl } from "@/utils/api-url"

export const INITIAL_PLAN_MARKER = "enkInitialPlan"

export type InitialPlanSessionState = {
  handoffMessageID: string | null
  planningID: string | null
  buildStarted: boolean
  lastPlanStatus: "running" | "done" | "error" | null
}

export type InitialPlanMode = "running" | "ready" | "failed"

export function isInitialPlanHandoff(part: { type: string; metadata?: Record<string, unknown> }) {
  return part.type === "text" && part.metadata?.[INITIAL_PLAN_MARKER] === true
}

// 최초 기획을 받은 뒤 아직 Build 가 시작되지 않았을 때만 의미가 있다. 그동안 팀의 피드백은 Plan 으로 간다.
export function initialPlanActive(state: InitialPlanSessionState | undefined) {
  return !!state?.handoffMessageID && !state.buildStarted
}

export function initialPlanMode(
  state: InitialPlanSessionState | undefined,
  busy: boolean,
): InitialPlanMode | undefined {
  if (!initialPlanActive(state)) return undefined
  if (busy || state!.lastPlanStatus === "running") return "running"
  if (state!.lastPlanStatus === "error") return "failed"
  if (state!.lastPlanStatus === "done") return "ready"
  return undefined
}

type Target = { baseUrl: string; directory: string; sessionID: string }

const url = (input: Target, value: string) => {
  const next = apiUrl(input.baseUrl, value)
  next.searchParams.set("directory", input.directory)
  return next
}

export async function fetchInitialPlanState(input: Target): Promise<InitialPlanSessionState> {
  const next = url(input, "/enk/initial-plan/session-state")
  next.searchParams.set("sessionID", input.sessionID)
  const res = await fetch(next)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function retryInitialPlan(input: Target): Promise<InitialPlanSessionState> {
  const res = await fetch(url(input, "/enk/initial-plan/retry"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionID: input.sessionID }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
