import { describe, expect, test } from "bun:test"
import {
  buildEnvPatch,
  envKeysChanged,
  envKeysSummary,
  envRowStatus,
  focusMounted,
  KEY_REGEX,
} from "./dialog-env-keys-form"

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

  test("true for drop, fresh with name, or a draft that differs from the revealed value", () => {
    expect(envKeysChanged([{ id: "A", name: "A", filled: true, drop: true }])).toBe(true)
    expect(envKeysChanged([{ id: "n", name: "NEW", filled: false, fresh: true, draft: "" }])).toBe(true)
    expect(envKeysChanged([{ id: "n", name: "  ", filled: false, fresh: true, draft: "" }])).toBe(false)
    // 잠금만 풀어 값을 확인하고 그대로 두면 변경이 아니다.
    expect(envKeysChanged([{ id: "A", name: "A", filled: true, editing: true, value: "v", draft: "v" }])).toBe(false)
    expect(envKeysChanged([{ id: "A", name: "A", filled: true, editing: true, value: "v" }])).toBe(false)
    expect(envKeysChanged([{ id: "A", name: "A", filled: true, value: "v", draft: "" }])).toBe(true)
  })
})

describe("envRowStatus", () => {
  test("maps rows to the mockup's four row states", () => {
    expect(envRowStatus({ id: "A", name: "A", filled: true })).toBe("registered")
    expect(envRowStatus({ id: "A", name: "A", filled: true, drop: true })).toBe("drop")
    expect(envRowStatus({ id: "A", name: "A", filled: true, editing: true, value: "v" })).toBe("editing")
    expect(envRowStatus({ id: "A", name: "A", filled: true, value: "v", draft: "next" })).toBe("replace")
    expect(envRowStatus({ id: "n", name: "N", filled: false, fresh: true })).toBe("fresh")
  })

  test("keeps the input open on empty-valued keys even after typing", () => {
    expect(envRowStatus({ id: "A", name: "A", filled: false })).toBe("needsValue")
    expect(envRowStatus({ id: "A", name: "A", filled: false, draft: "typed" })).toBe("needsValue")
  })

  test("drop wins over a pending replacement", () => {
    expect(envRowStatus({ id: "A", name: "A", filled: true, value: "v", draft: "next", drop: true })).toBe("drop")
  })
})

describe("envKeysSummary", () => {
  test("counts replacements and removals, ignoring rows only looked at", () => {
    expect(
      envKeysSummary([
        { id: "A", name: "A", filled: true, value: "v", draft: "next" },
        { id: "B", name: "B", filled: true, editing: true, value: "v", draft: "v" },
        { id: "C", name: "C", filled: true, drop: true },
        { id: "D", name: "D", filled: true },
        { id: "n", name: "NEW", filled: false, fresh: true, draft: "x" },
      ]),
    ).toEqual({ replace: 2, drop: 1 })
  })

  test("is all zero when nothing changed", () => {
    expect(envKeysSummary([{ id: "A", name: "A", filled: true }])).toEqual({ replace: 0, drop: 0 })
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

  test("writes only when the draft differs from the revealed value", () => {
    // 열어서 보기만 한 줄은 .env 를 다시 쓰지 않는다 — 저장 시 미리보기 재시작이 따라오기 때문.
    const looked = buildEnvPatch([{ id: "A", name: "A", filled: true, editing: true, value: "v", draft: "v" }], t)
    expect(looked.patch).toEqual({ values: {}, drops: [] })

    const cleared = buildEnvPatch([{ id: "A", name: "A", filled: true, value: "v", draft: "" }], t)
    expect(cleared.patch).toEqual({ values: { A: "" }, drops: [] })
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
