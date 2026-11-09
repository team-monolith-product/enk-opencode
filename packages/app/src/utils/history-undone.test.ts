import { describe, expect, test } from "bun:test"
import { undoneVersions } from "./history-undone"

const undone = (entries: { sha: string; revert?: string }[]) => [...undoneVersions(entries)]

describe("undoneVersions", () => {
  test("marks versions between a rollback and its target", () => {
    expect(undone([{ sha: "r", revert: "v1" }, { sha: "backup" }, { sha: "v2" }, { sha: "v1" }])).toEqual([
      "backup",
      "v2",
    ])
  })

  test("keeps work made after a rollback", () => {
    expect(undone([{ sha: "v3" }, { sha: "r", revert: "v1" }, { sha: "v2" }, { sha: "v1" }])).toEqual(["v2"])
  })

  test("rolling back a rollback greys out only the first rollback", () => {
    expect(undone([{ sha: "r2", revert: "v2" }, { sha: "r1", revert: "v1" }, { sha: "v2" }, { sha: "v1" }])).toEqual([
      "r1",
    ])
  })

  test("ignores rollbacks inside a skipped range", () => {
    expect(
      undone([{ sha: "r2", revert: "v1" }, { sha: "v3" }, { sha: "r1", revert: "v2" }, { sha: "v2" }, { sha: "v1" }]),
    ).toEqual(["v3", "r1", "v2"])
  })

  test("nothing is undone without a rollback", () => {
    expect(undone([{ sha: "v2" }, { sha: "v1" }])).toEqual([])
  })
})
