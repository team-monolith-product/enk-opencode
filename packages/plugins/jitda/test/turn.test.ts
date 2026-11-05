import { describe, expect, test } from "bun:test"
import { TurnSummary } from "../src/turn"

const model = { providerID: "fake", id: "m" }

describe("TurnSummary.compose", () => {
  test("lists what changed under the summary", () => {
    expect(
      TurnSummary.compose("할 일 앱 만들기", [
        { status: "A", file: "index.html" },
        { status: "M", file: "app.js" },
        { status: "D", file: "old.css" },
      ]),
    ).toBe("할 일 앱 만들기\n\n- 추가: index.html\n- 수정: app.js\n- 삭제: old.css")
  })

  test("keeps the subject short and the file list bounded", () => {
    const changes = Array.from({ length: 32 }, (_, i) => ({ status: "M" as const, file: `f${i}.txt` }))

    const lines = TurnSummary.compose("x".repeat(100), changes, "en").split("\n")

    expect(lines[0]).toHaveLength(72)
    expect(lines).toHaveLength(2 + 30 + 1)
    expect(lines.at(-1)).toBe("- … +2")
  })
})

describe("TurnSummary.first", () => {
  test("names the first commit in the viewer locale", () => {
    const changes = [{ status: "A" as const, file: "index.html" }]

    expect(TurnSummary.compose(TurnSummary.first("en"), changes, "en")).toBe(
      "First push from Jitda\n\n- Add: index.html",
    )
    expect(TurnSummary.compose(TurnSummary.first(), changes)).toBe("짓다에서 처음 올린 내용\n\n- 추가: index.html")
  })

  test("names a manual push in the viewer locale", () => {
    const changes = [{ status: "M" as const, file: "index.html" }]

    expect(TurnSummary.compose(TurnSummary.manual("en"), changes, "en")).toBe(
      "Manual push from Jitda\n\n- Update: index.html",
    )
    expect(TurnSummary.compose(TurnSummary.manual(), changes)).toBe("짓다에서 직접 올린 내용\n\n- 수정: index.html")
  })
})

describe("TurnSummary.latest", () => {
  test("reads the last request and the final reply of the turn", () => {
    expect(
      TurnSummary.latest([
        { id: "msg_1", type: "user", text: "첫 요청" },
        { id: "msg_2", type: "assistant", content: [{ type: "text", text: "첫 답" }], model },
        { id: "msg_3", type: "user", text: "버튼 색 바꿔줘", metadata: { locale: "en" } },
        { id: "msg_4", type: "synthetic", text: "system reminder" },
        { id: "msg_5", type: "assistant", content: [{ type: "tool" }], model },
        { id: "msg_6", type: "assistant", content: [{ type: "text", text: "바꿨어요" }], model },
      ]),
    ).toEqual({ id: "msg_3", request: "버튼 색 바꿔줘", reply: "바꿨어요", locale: "en", model })
  })

  test("returns nothing before the first request", () => {
    expect(TurnSummary.latest([])).toBeUndefined()
    expect(TurnSummary.latest([{ id: "msg_1", type: "assistant", content: [] }])).toBeUndefined()
  })
})
