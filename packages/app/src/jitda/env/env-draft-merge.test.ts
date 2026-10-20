import { describe, expect, test } from "bun:test"
import { merge } from "./env-draft-merge"

describe("env draft merge", () => {
  test("applies both fields when nothing is focused", () => {
    expect(merge(undefined, { key: "A", value: "1" })).toEqual({ key: "A", value: "1" })
  })

  test("keeps the focused value field local during IME composition", () => {
    expect(merge("value", { key: "A", value: "remote" })).toEqual({ key: "A" })
  })

  test("keeps the focused key field local", () => {
    expect(merge("key", { key: "remote", value: "1" })).toEqual({ value: "1" })
  })

  test("still reports remote key so callers can choose to ignore rename UI", () => {
    // 도크는 이름 칸이 없어서 key 패치를 버린다. merge 자체는 순수 함수로 key 를 그대로 넘긴다.
    expect(merge("value", { key: "HIJACKED", value: "x" })).toEqual({ key: "HIJACKED" })
  })
})
