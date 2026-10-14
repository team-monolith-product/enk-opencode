import type { Message, Part } from "@opencode-ai/sdk/v2"

export const INITIAL_PLAN_MARKER = "enkInitialPlan"

function isHandoff(parts: Part[] | undefined) {
  return !!parts?.some((part) => part.type === "text" && part.metadata?.[INITIAL_PLAN_MARKER] === true)
}

// 최초 기획을 받은 Plan 이 제작 순서를 다 말했고 아직 아무도 Build 를 부르지 않았을 때만 CTA 를 띄운다.
// Plan 과 몇 번 더 이야기해도 CTA 는 남고, Build 요청이 한 번이라도 나가면 사라진다.
export function showInitialPlanCta(input: {
  messages: Message[] | undefined
  parts: (messageID: string) => Part[] | undefined
  busy: boolean
}) {
  if (input.busy) return false
  const messages = input.messages ?? []
  const start = messages.findLastIndex((msg) => msg.role === "user" && isHandoff(input.parts(msg.id)))
  if (start < 0) return false
  const after = messages.slice(start + 1)
  if (after.some((msg) => msg.role === "user" && msg.agent !== "plan")) return false
  const last = messages.at(-1)
  if (!last || last.role !== "assistant") return false
  return last.agent === "plan" && !!last.time.completed && !last.error
}
