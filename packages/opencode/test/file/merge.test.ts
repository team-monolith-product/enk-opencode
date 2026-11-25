import { describe, expect, test } from "bun:test"
import { FileMerge } from "../../src/file/merge"

describe("FileMerge.three", () => {
  test("keeps both sides when they changed different lines", async () => {
    const result = await FileMerge.three({ base: "a\nb\nc\n", current: "A\nb\nc\n", ours: "a\nb\nC\n" })
    expect(result).toEqual({ clean: true, content: "A\nb\nC\n" })
  })

  test("reports a conflict when both sides changed the same line", async () => {
    const result = await FileMerge.three({ base: "a\nb\nc\n", current: "a\nB1\nc\n", ours: "a\nB2\nc\n" })
    expect(result.clean).toBe(false)
  })

  test("returns ours untouched when nobody else changed the file", async () => {
    expect(await FileMerge.three({ base: "a\n", current: "a\n", ours: "b\n" })).toEqual({ clean: true, content: "b\n" })
  })
})
