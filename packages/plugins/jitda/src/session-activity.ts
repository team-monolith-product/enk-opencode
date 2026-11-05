// 작업 폴더별로 지금 AI 가 돌고 있는 세션. 플러그인은 서버의 실행 목록을 읽을 수 없어 턴 이벤트와 context 훅으로 센다.

const running = new Map<string, Set<string>>()

export function start(directory: string, sessionID: string) {
  const set = running.get(directory) ?? new Set<string>()
  set.add(sessionID)
  running.set(directory, set)
}

export function finish(directory: string, sessionID: string) {
  const set = running.get(directory)
  if (!set) return
  set.delete(sessionID)
  if (set.size === 0) running.delete(directory)
}

// 이벤트 스트림이 끊기면 끝난 턴을 놓칠 수 있어 비운다. 돌고 있는 턴은 다음 모델 호출에서 다시 잡힌다.
export function reset(directory: string) {
  running.delete(directory)
}

export function has(directory: string, sessionID: string) {
  return running.get(directory)?.has(sessionID) ?? false
}

export function working(directory: string) {
  return running.has(directory)
}

export * as SessionActivity from "./session-activity"
