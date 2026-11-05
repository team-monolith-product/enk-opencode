type Entry = { sha: string; revert?: string }

/**
 * 되돌리기로 지금 상태에서 빠진 버전들. 최신부터 내려가며 되돌리기를 만나면 그 대상까지 건너뛴다.
 * 건너뛴 구간 안의 되돌리기는 따르지 않는다.
 */
export function undoneVersions(entries: Entry[]) {
  const undone = new Set<string>()
  let target: string | undefined
  for (const entry of entries) {
    if (target && entry.sha !== target) {
      undone.add(entry.sha)
      continue
    }
    target = entry.revert
  }
  return undone
}
