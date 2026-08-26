import type { SessionID } from "./schema"
import { Session } from "./index"
import { SessionPrompt } from "./prompt"
import { ensureSession } from "./ensure"

/**
 * 세션을 지운다(속으로는 보관).
 *
 * 지우는 순간 그 대화는 아무도 다시 열 수 없다. 돌고 있던 응답을 그대로 두면 아무도 보지 않는
 * 세션에서 LLM 이 계속 돌며 토큰과 요금만 태우고, 권한·질문 대기에 걸리면 영영 멈춰 있는다.
 * 그래서 보관 전에 실행을 먼저 끊는다.
 *
 * 보관 뒤에는 대체 세션을 만들어 둔다(ensureSession). 같은 세션을 함께 보던 사람들이 옮겨갈
 * 자리이고, 그래야 지운 사람과 나머지가 같은 새 세션에서 만난다.
 *
 * 이미 보관된 세션이면 아무것도 하지 않고 false 를 돌려준다 — 여럿이 동시에 눌러도 먼저 온 하나만
 * 인정한다. 늦게 온 요청이 보관 시각을 덮어쓰거나 session.updated 를 다시 뿌리지 않게 하기 위함이다.
 */
export async function archiveSession(input: { sessionID: SessionID; time?: number }) {
  const session = await Session.get(input.sessionID)
  if (session.time.archived) return false

  await SessionPrompt.cancel(input.sessionID)
  await Session.setArchived({ sessionID: input.sessionID, time: input.time ?? Date.now() })
  await ensureSession()
  return true
}

/** 세션을 완전히 지운다. 보관과 같은 이유로 실행부터 끊고, 자리를 대신할 세션을 남긴다. */
export async function removeSession(sessionID: SessionID) {
  await SessionPrompt.cancel(sessionID)
  await Session.remove(sessionID)
  await ensureSession()
}
