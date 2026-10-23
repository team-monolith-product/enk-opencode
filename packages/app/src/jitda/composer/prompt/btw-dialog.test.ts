import { describe, expect, test } from "bun:test"
import { btwQuestion } from "./btw-dialog"

describe("btwQuestion", () => {
  test("reads the side question after /btw", () => {
    expect(btwQuestion("/btw 이 함수는 왜 느려?")).toBe("이 함수는 왜 느려?")
    expect(btwQuestion("  /btw\n여러 줄\n질문 ")).toBe("여러 줄\n질문")
  })

  test("returns an empty question for a bare /btw", () => {
    expect(btwQuestion("/btw")).toBe("")
    expect(btwQuestion("/btw   ")).toBe("")
  })

  test("leaves other prompts alone", () => {
    expect(btwQuestion("버튼 색 바꿔 줘")).toBeUndefined()
    expect(btwQuestion("/btwx 질문")).toBeUndefined()
    expect(btwQuestion("앞에 글 /btw 질문")).toBeUndefined()
  })
})
