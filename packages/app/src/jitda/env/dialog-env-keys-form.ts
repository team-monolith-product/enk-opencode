export const KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/

export type EnvRow = {
  id: string
  name: string
  filled: boolean
  /** 등록/수정 시각(ms). filled 줄만. */
  updated_at?: number
  fresh?: boolean
  draft?: string
  editing?: boolean
  drop?: boolean
  /** 잠금을 풀어 서버에서 받아온 원래 값. draft 가 이것과 같으면 교체로 치지 않는다. */
  value?: string
}

/**
 * 시안의 줄 상태. registered 는 잠금칩, replace 는 「저장하면 적용」(강조 배경),
 * needsValue 는 값이 비어 입력칸이 열려 있는 줄이다.
 */
export type EnvRowStatus = "drop" | "fresh" | "editing" | "replace" | "needsValue" | "registered"

export function envRowStatus(row: EnvRow): EnvRowStatus {
  if (row.drop) return "drop"
  if (row.fresh) return "fresh"
  if (row.editing) return "editing"
  // 값이 비어 있는 줄은 고쳐도 입력칸을 계속 열어 둔다 — 시안의 「값 필요」줄.
  if (!row.filled) return "needsValue"
  if (draftChanged(row)) return "replace"
  return "registered"
}

/** 잠금만 풀고 값을 그대로 둔 줄은 변경이 아니다 — 저장 대상에서도 빠진다. */
function draftChanged(row: EnvRow) {
  return row.draft !== undefined && row.draft !== (row.value ?? "")
}

/** 푸터의 "저장하면 교체 N건 · 삭제 N건 반영돼요" 카운트. */
export function envKeysSummary(rows: EnvRow[]) {
  let replace = 0
  let drop = 0
  for (const row of rows) {
    if (row.drop) {
      drop++
      continue
    }
    if (row.fresh ? !!row.name.trim() : draftChanged(row)) replace++
  }
  return { replace, drop }
}

export type EnvErr = { key?: string; value?: string }

export type EnvPatch = {
  values: Record<string, string>
  drops: string[]
}

type Translator = (key: string, vars?: Record<string, string | number | boolean>) => string

/** 다이얼로그가 이미 열린 뒤 마운트된 input 은 HTML autofocus 가 안 먹으므로 마운트 시 직접 focus 한다. */
export function focusMounted(el: HTMLElement) {
  queueMicrotask(() => el.focus())
}

export function envKeysChanged(rows: EnvRow[]) {
  return rows.some((row) => {
    if (row.drop) return true
    // 이름은 필수, 값은 빈 문자열 허용 — 직접 추가 줄은 이름만 있어도 저장 가능.
    if (row.fresh) return !!row.name.trim()
    return draftChanged(row)
  })
}

export function buildEnvPatch(rows: EnvRow[], t: Translator) {
  const values: Record<string, string> = {}
  const drops: string[] = []
  const errs: Record<string, EnvErr> = {}
  const seen = new Set<string>()
  let ok = true

  for (const row of rows) {
    if (row.drop) {
      drops.push(row.name)
      continue
    }

    const name = row.name.trim()
    const value = row.draft?.trim() ?? ""

    // 잠금만 풀고 값을 그대로 둔 줄도 "안 건드린" 줄이다 — 기존 값을 그대로 유지한다.
    if (row.filled && !draftChanged(row)) {
      if (seen.has(name)) {
        ok = false
        errs[row.id] = { key: t("envKeys.error.duplicate") }
        continue
      }
      seen.add(name)
      continue
    }

    const err: EnvErr = {}
    if (!KEY_REGEX.test(name)) err.key = t("envKeys.error.invalidKey")
    else if (seen.has(name)) err.key = t("envKeys.error.duplicate")

    if (err.key) {
      ok = false
      errs[row.id] = err
      continue
    }
    seen.add(name)
    values[name] = value
  }

  if (!ok) return { errs }
  return { patch: { values, drops } satisfies EnvPatch, errs }
}
