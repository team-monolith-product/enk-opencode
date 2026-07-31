import { describe, expect, test } from "bun:test"
import { buildEnvPatch, envKeysChanged, focusMounted, formatSavedAt, KEY_REGEX } from "./dialog-env-keys-form"

const t = (key: string) => key

describe("KEY_REGEX", () => {
  test("rejects empty and invalid names", () => {
    expect(KEY_REGEX.test("")).toBe(false)
    expect(KEY_REGEX.test("1BAD")).toBe(false)
    expect(KEY_REGEX.test("A-B")).toBe(false)
    expect(KEY_REGEX.test("GOOD_KEY")).toBe(true)
  })
})

describe("envKeysChanged", () => {
  test("false when filled rows are untouched", () => {
    expect(envKeysChanged([{ id: "A", name: "A", filled: true }])).toBe(false)
  })

  test("true for drop, fresh with name, editing, or draft including empty string", () => {
    expect(envKeysChanged([{ id: "A", name: "A", filled: true, drop: true }])).toBe(true)
    expect(envKeysChanged([{ id: "n", name: "NEW", filled: false, fresh: true, draft: "" }])).toBe(true)
    expect(envKeysChanged([{ id: "n", name: "  ", filled: false, fresh: true, draft: "" }])).toBe(false)
    expect(envKeysChanged([{ id: "A", name: "A", filled: true, editing: true }])).toBe(true)
    expect(envKeysChanged([{ id: "A", name: "A", filled: true, draft: "" }])).toBe(true)
  })
})

describe("buildEnvPatch", () => {
  test("keeps untouched filled rows out of values", () => {
    const result = buildEnvPatch([{ id: "A", name: "A", filled: true }], t)
    expect(result.patch).toEqual({ values: {}, drops: [] })
    expect(result.errs).toEqual({})
  })

  test("allows empty value for fresh rows with valid name", () => {
    const result = buildEnvPatch([{ id: "n", name: "EMPTY_OK", filled: false, fresh: true, draft: "" }], t)
    expect(result.patch).toEqual({ values: { EMPTY_OK: "" }, drops: [] })
  })

  test("rejects empty name even when value is set", () => {
    const result = buildEnvPatch([{ id: "n", name: "", filled: false, fresh: true, draft: "x" }], t)
    expect(result.patch).toBeUndefined()
    expect(result.errs.n?.key).toBe("envKeys.error.invalidKey")
  })

  test("writes empty string when filled row is editing or has draft", () => {
    const editing = buildEnvPatch([{ id: "A", name: "A", filled: true, editing: true }], t)
    expect(editing.patch).toEqual({ values: { A: "" }, drops: [] })

    const draft = buildEnvPatch([{ id: "A", name: "A", filled: true, draft: "" }], t)
    expect(draft.patch).toEqual({ values: { A: "" }, drops: [] })
  })

  test("collects drops and new values together", () => {
    const result = buildEnvPatch(
      [
        { id: "OLD", name: "OLD", filled: true, drop: true },
        { id: "n", name: "NEW", filled: false, fresh: true, draft: "v" },
      ],
      t,
    )
    expect(result.patch).toEqual({ values: { NEW: "v" }, drops: ["OLD"] })
  })

  test("flags duplicate names", () => {
    const result = buildEnvPatch(
      [
        { id: "a", name: "SAME", filled: false, fresh: true, draft: "1" },
        { id: "b", name: "SAME", filled: false, fresh: true, draft: "2" },
      ],
      t,
    )
    expect(result.patch).toBeUndefined()
    expect(result.errs.b?.key).toBe("envKeys.error.duplicate")
  })

  test("leaves untouched filled keys alone while saving a new empty key", () => {
    const result = buildEnvPatch(
      [
        { id: "KEEP", name: "KEEP", filled: true },
        { id: "n", name: "NEW", filled: false, fresh: true, draft: "" },
      ],
      t,
    )
    expect(result.patch).toEqual({ values: { NEW: "" }, drops: [] })
  })

  test("replaces filled value when draft is non-empty", () => {
    const result = buildEnvPatch([{ id: "A", name: "A", filled: true, draft: " next " }], t)
    expect(result.patch).toEqual({ values: { A: "next" }, drops: [] })
  })
})

describe("focusMounted", () => {
  test("focuses the element on the next microtask", async () => {
    const el = document.createElement("input")
    document.body.appendChild(el)
    focusMounted(el)
    expect(document.activeElement).not.toBe(el)
    await Promise.resolve()
    expect(document.activeElement).toBe(el)
    el.remove()
  })
})

describe("formatSavedAt", () => {
  const t = (key: string, vars?: Record<string, string | number | boolean>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key
  const now = Date.parse("2026-07-31T21:00:00")

  test("uses relative labels within a day", () => {
    expect(formatSavedAt(now - 30_000, t, now)).toBe("envKeys.saved.justNow")
    expect(formatSavedAt(now - 3 * 60_000, t, now)).toBe('envKeys.saved.minutesAgo:{"count":3}')
    expect(formatSavedAt(now - 5 * 3_600_000, t, now)).toBe('envKeys.saved.hoursAgo:{"count":5}')
  })

  test("uses absolute label after a day", () => {
    expect(formatSavedAt(Date.parse("2026-07-29T21:02:00"), t, now)).toBe(
      'envKeys.saved.at:{"month":7,"day":29,"time":"21:02"}',
    )
  })

  test("falls back when timestamp is missing", () => {
    expect(formatSavedAt(undefined, t, now)).toBe("envKeys.saved")
  })
})
