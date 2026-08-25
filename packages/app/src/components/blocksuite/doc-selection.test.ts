import { describe, expect, test } from "bun:test"
import { repairSelection } from "./doc-selection"

const live = (...ids: string[]) => (id: string) => ids.includes(id)

describe("repairSelection", () => {
  test("stays quiet while every entry points at a live block", () => {
    const current = [{ type: "text", blockId: "a" }]
    expect(repairSelection(current, live("a", "b"), () => "a")).toBeUndefined()
  })

  test("keeps an entry that carries no blockId", () => {
    const current = [{ type: "surface" }]
    expect(repairSelection(current, live(), () => "p")).toBeUndefined()
  })

  test("drops the dangling entry and keeps the rest", () => {
    const current = [
      { type: "block", blockId: "gone" },
      { type: "text", blockId: "a" },
    ]
    expect(repairSelection(current, live("a"), () => "p")).toEqual({ keep: [{ type: "text", blockId: "a" }] })
  })

  test("falls back to a caret when nothing survives", () => {
    const current = [{ type: "text", blockId: "gone" }]
    expect(repairSelection(current, live("p"), () => "p")).toEqual({ keep: [], caret: "p" })
  })

  test("reports the empty selection when there is nowhere to put a caret", () => {
    const current = [{ type: "text", blockId: "gone" }]
    expect(repairSelection(current, live(), () => undefined)).toEqual({ keep: [] })
  })
})
