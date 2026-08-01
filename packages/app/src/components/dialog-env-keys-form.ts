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

/** 시안: 최근은 상대시각, 하루 넘으면 "M월 D일 HH:mm 등록". */
export function formatSavedAt(at: number | undefined, t: Translator, now = Date.now()) {
  if (at === undefined || !Number.isFinite(at)) return t("envKeys.saved")
  const diff = Math.max(0, now - at)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return t("envKeys.saved.justNow")
  if (minutes < 60) return t("envKeys.saved.minutesAgo", { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t("envKeys.saved.hoursAgo", { count: hours })
  const date = new Date(at)
  const hh = String(date.getHours()).padStart(2, "0")
  const mm = String(date.getMinutes()).padStart(2, "0")
  return t("envKeys.saved.at", {
    month: date.getMonth() + 1,
    day: date.getDate(),
    time: `${hh}:${mm}`,
  })
}

export function envKeysChanged(rows: EnvRow[]) {
  return rows.some((row) => {
    if (row.drop) return true
    // 이름은 필수, 값은 빈 문자열 허용 — 직접 추가 줄은 이름만 있어도 저장 가능.
    if (row.fresh) return !!row.name.trim()
    if (row.editing || row.draft !== undefined) return true
    return false
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

    // 등록된 줄을 안 건드렸으면 기존 값 유지. 값 칸을 연 적 있으면 빈 문자열도 저장한다.
    if (row.filled && row.draft === undefined && !row.editing) {
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
