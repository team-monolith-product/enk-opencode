type Requester = () => Promise<boolean>

const requesters = new Map<string, Requester>()

/**
 * 지우기 확인창(레이아웃)과 동의 투표(세션의 prompt doc)를 잇는 자리.
 *
 * 확인창은 앱 셸에, 투표에 필요한 것들(doc·actor·합의 소켓)은 세션 안에 있어 서로 컨텍스트가 닿지
 * 않는다. 세션이 자기 요청 함수를 여기 걸어두면, 확인창은 지금 열려 있는 세션에 한해 동의를 먼저
 * 구할 수 있다. 걸린 게 없으면(사이드바에서 안 보고 있는 세션을 지우는 경우 등) 그냥 지운다.
 */
export const SessionClearVote = {
  register(sessionID: string, fn: Requester) {
    requesters.set(sessionID, fn)
    return () => {
      if (requesters.get(sessionID) === fn) requesters.delete(sessionID)
    }
  },
  /** 동의 투표를 시작했으면 true. false 면 물어볼 상대가 없으니 호출한 쪽이 바로 지운다. */
  async request(sessionID: string) {
    const fn = requesters.get(sessionID)
    if (!fn) return false
    return fn()
  },
}
