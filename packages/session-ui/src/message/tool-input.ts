import { diffLines } from "diff"

// 스트리밍 중인 도구 입력 JSON 에서 닫힌 문자열·끝난 숫자·불리언만 꺼낸다. 덜 도착한 값은 무시한다.
export function parsePartialToolInput(raw: string): Record<string, unknown> | undefined {
  if (!raw) return
  const out: Record<string, unknown> = {}
  let any = false
  for (const match of raw.matchAll(/"([^"\\]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    const key = match[1]
    if (!key) continue
    try {
      out[key] = JSON.parse(`"${match[2]}"`)
    } catch {
      out[key] = match[2]
    }
    any = true
  }
  for (const match of raw.matchAll(/"([^"\\]+)"\s*:\s*(-?\d+(?:\.\d+)?)(?=[,}\s])/g)) {
    const key = match[1]
    if (!key) continue
    const value = Number(match[2])
    if (Number.isFinite(value)) {
      out[key] = value
      any = true
    }
  }
  for (const match of raw.matchAll(/"([^"\\]+)"\s*:\s*(true|false)(?=[,}\s])/g)) {
    const key = match[1]
    if (!key) continue
    out[key] = match[2] === "true"
    any = true
  }
  return any ? out : undefined
}

// 두 문자열이 다 도착하면 서버 filediff 와 같은 줄 diff 를 써서 완료 순간 숫자가 튀지 않게 한다.
export function editPendingDiff(input: { oldString: unknown; newString: unknown; raw?: unknown }) {
  const oldClosed = typeof input.oldString === "string" ? input.oldString : null
  const newClosed = typeof input.newString === "string" ? input.newString : null

  if (oldClosed !== null && newClosed !== null) {
    let additions = 0
    let deletions = 0
    for (const change of diffLines(oldClosed, newClosed)) {
      if (change.added) additions += change.count ?? 0
      if (change.removed) deletions += change.count ?? 0
    }
    return { additions, deletions }
  }

  const lineCount = (closed: string | null, key: string): number => {
    if (closed !== null) return closed === "" ? 0 : closed.split("\n").length
    if (typeof input.raw === "string") return countPartialStringLines(input.raw, key)
    return 0
  }
  return {
    additions: lineCount(newClosed, "newString"),
    deletions: lineCount(oldClosed, "oldString"),
  }
}

// 아직 닫히지 않은 JSON 문자열 값의 줄 수(1부터). 키가 없으면 0.
export function countPartialStringLines(raw: string, key: string): number {
  if (!raw || !key) return 0
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const start = raw.match(new RegExp(`"${escaped}"\\s*:\\s*"`))
  if (!start || start.index === undefined) return 0
  let i = start.index + start[0].length
  let lines = 1
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === "\\" && i + 1 < raw.length) {
      if (raw[i + 1] === "n") lines++
      i += 2
      continue
    }
    if (ch === '"') break
    i++
  }
  return lines
}
