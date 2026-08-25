import { createSignal } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2/client"

/** 대체 세션을 기다리는 시간. 이벤트 스트림이 끊긴 채로 사라진 대화를 붙들고 있지 않도록 건다. */
export const REPLACEMENT_WAIT_MS = 5_000

/**
 * 보고 있던 세션이 지워졌을 때(보관·삭제) 그 자리를 대신할 세션.
 *
 * 세션 목록은 id 오름차순이고 세션 id 는 내림차순으로 발급되므로 첫 루트 세션이 가장 최근 세션이다.
 * 서브에이전트(자식) 세션은 대화 화면의 주인이 아니니 대상에서 뺀다.
 */
export function pickReplacementSession(sessions: readonly Session[] | undefined, removedID?: string) {
  return sessions?.find((s) => !s.parentID && !s.time?.archived && s.id !== removedID)
}

/**
 * 지금 보던 세션이 사라졌고 새 세션을 기다리는 중인 디렉터리.
 *
 * 세션을 지운 쪽은 요청 응답으로, 같이 보고 있던 쪽은 session.updated(archived) 이벤트로 서로 다른
 * 자리에서 같은 사실을 알게 된다. 두 경로가 같은 대기 상태를 쓰도록 디렉터리 단위로 모듈에 둔다.
 * 실제 이동은 directory-layout 이 맡는다.
 */
const [waiting, setWaiting] = createSignal<Record<string, true>>({})

export const SessionFollow = {
  expect(directory: string) {
    setWaiting((prev) => (prev[directory] ? prev : { ...prev, [directory]: true }))
  },
  waiting(directory: string) {
    return !!waiting()[directory]
  },
  clear(directory: string) {
    setWaiting((prev) => {
      if (!prev[directory]) return prev
      const next = { ...prev }
      delete next[directory]
      return next
    })
  },
}
