type Requester = (sha: string) => Promise<void>

const requesters = new Map<string, Requester>()

/**
 * 버전 기록 창(미리보기 패널에서 띄우는 다이얼로그)과 되돌리기 동의 투표(세션의 prompt doc)를 잇는 자리.
 * 지우기와 같은 이유로 둘의 컨텍스트가 닿지 않는다. 되돌리기는 언제나 서버의 투표를 거치므로, 걸린 게
 * 없으면 되돌릴 수 없다.
 */
export const SessionRollbackVote = {
  register(sessionID: string, fn: Requester) {
    requesters.set(sessionID, fn)
    return () => {
      if (requesters.get(sessionID) === fn) requesters.delete(sessionID)
    }
  },
  ready(sessionID: string) {
    return requesters.has(sessionID)
  },
  async request(sessionID: string, sha: string) {
    const fn = requesters.get(sessionID)
    if (!fn) throw new RollbackError("unavailable")
    return fn(sha)
  },
}

export type RollbackCode = "closed" | "busy" | "missing" | "conflict" | "unavailable" | "failed"

export class RollbackError extends Error {
  constructor(readonly code: RollbackCode) {
    super(code)
    this.name = "RollbackError"
  }
}

/** 서버가 돌려준 오류 본문에서 되돌리기를 막은 이유를 고른다. */
export function rollbackCode(text: string): RollbackCode {
  const body = (() => {
    try {
      return JSON.parse(text) as { code?: unknown; name?: unknown }
    } catch {
      return undefined
    }
  })()
  if (body?.name === "DocVoteConflictError") return "conflict"
  if (body?.code === "closed" || body?.code === "busy" || body?.code === "missing") return body.code
  return "failed"
}
