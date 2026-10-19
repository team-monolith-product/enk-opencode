import { describe, expect, test } from "bun:test"
import { Snapshot } from "../../src/snapshot"
import { diffContents } from "../../../ui/src/util/diff-contents"

describe("Snapshot.unifiedPatch", () => {
  test.each([
    ["same\ncontent\n", "same\ncontent\n"],
    ["no newline", "no newline"],
    ["a\nb\n", "a\nc\n"],
  ])("keeps both sides recoverable", (before, after) => {
    expect(diffContents({ patch: Snapshot.unifiedPatch("f", before, after) })).toEqual({ before, after })
  })

  test("leaves the byte order mark out of the diff", () => {
    const patch = Snapshot.unifiedPatch("f", "﻿a\n", "﻿b\n")
    expect(patch).not.toContain("﻿")
    expect(diffContents({ patch })).toEqual({ before: "a\n", after: "b\n" })
  })
})
