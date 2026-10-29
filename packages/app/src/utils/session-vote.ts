type Requesters = {
  /** 지우기 동의 투표를 시작했으면 true. false 면 물어볼 상대가 없으니 호출한 쪽이 바로 지운다. */
  clear: () => Promise<boolean>
  /** 되돌리기 투표를 시작했으면 true(혼자면 서버가 바로 되돌린다). false 면 세션이 아직 투표할 준비가 안 됐다. */
  rollback: (sha: string) => Promise<boolean>
}

const sessions = new Map<string, Requesters>()

/**
 * 앱 셸의 확인창·다이얼로그(지우기 확인, 버전 기록)와 동의 투표(세션의 prompt doc)를 잇는 자리.
 *
 * 다이얼로그는 앱 셸에, 투표에 필요한 것들(doc·actor·합의 소켓)은 세션 안에 있어 서로 컨텍스트가 닿지 않는다.
 * 세션이 자기 요청 함수들을 여기 걸어두면, 다이얼로그는 지금 열려 있는 세션에 한해 동의를 구할 수 있다.
 */
export const SessionVote = {
  register(sessionID: string, requesters: Requesters) {
    sessions.set(sessionID, requesters)
    return () => {
      if (sessions.get(sessionID) === requesters) sessions.delete(sessionID)
    }
  },
  get(sessionID: string) {
    return sessions.get(sessionID)
  },
}
