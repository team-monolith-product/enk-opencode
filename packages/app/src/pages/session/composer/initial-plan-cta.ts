import { apiUrl } from "@/utils/api-url"

export type InitialPlanSessionState = {
  handoffMessageID: string | null
  planningID: string | null
  buildStarted: boolean
  lastPlanStatus: "running" | "done" | "error" | null
}

export const INITIAL_PLAN_NONE: InitialPlanSessionState = {
  handoffMessageID: null,
  planningID: null,
  buildStarted: false,
  lastPlanStatus: null,
}

export type InitialPlanMode = "running" | "ready" | "failed"

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

// 다시 물어야 할 때만 바뀌는 키. Build 가 시작됐으면 더 묻지 않고, 전달이 없는 세션은 새 사용자 메시지가 올 때만 묻는다.
export function initialPlanRefreshKey(
  state: InitialPlanSessionState | undefined,
  signals: { status?: string; count?: number; lastID?: string; lastCompleted?: number; lastUserID?: string },
) {
  if (state?.buildStarted) return "settled"
  if (state && !state.handoffMessageID) return `idle:${signals.lastUserID ?? ""}`
  return [signals.status, signals.count, signals.lastID, signals.lastCompleted].join(":")
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
