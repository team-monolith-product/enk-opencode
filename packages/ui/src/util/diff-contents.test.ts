import { describe, expect, test } from "bun:test"
import { formatPatch, structuredPatch } from "diff"
import { diffContents } from "./diff-contents"

const full = (before: string, after: string) =>
  formatPatch(structuredPatch("f", "f", before, after, "", "", { context: Number.MAX_SAFE_INTEGER }))

describe("diffContents", () => {
  test.each([
    ["a\nb\nc\n", "a\nB\nc\nd\n"],
    ["", "new\nfile\n"],
    ["gone\n", ""],
    ["x\ny", "x\nz"],
    ["x\ny\n", "x\ny"],
    ["x\ny", "x\ny\n"],
    ["한글\n줄\n", "한글\n바뀐 줄\n"],
    ["- dash\n+ plus\n \n", "- dash\n++ plus\n\n"],
  ])("rebuilds both sides from a full-context patch", (before, after) => {
    expect(diffContents({ patch: full(before, after) })).toEqual({ before, after })
  })

  test("falls back to stored before/after for diffs saved before patches", () => {
    expect(diffContents({ before: "old", after: "new" })).toEqual({ before: "old", after: "new" })
  })

  test("rebuilds added and deleted files from the tool diff when no patch is stored", () => {
    const added = formatPatch(structuredPatch("f", "f", "", "new\nfile\n"))
    const deleted = formatPatch(structuredPatch("f", "f", "old\nfile\n", ""))
    expect(diffContents({ diff: added })).toEqual({ before: "", after: "new\nfile\n" })
    expect(diffContents({ diff: deleted })).toEqual({ before: "old\nfile\n", after: "" })
  })

  test("returns empty sides when nothing is stored", () => {
    expect(diffContents(undefined)).toEqual({ before: "", after: "" })
    expect(diffContents({ patch: "" })).toEqual({ before: "", after: "" })
  })
})
