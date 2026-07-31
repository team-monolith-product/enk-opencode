import { describe, expect, test } from "bun:test"
import { dict as en } from "./en"
import { dict as ko } from "./ko"

// 이 앱 i18n 은 {{name}} 이중 중괄호. 단일 {url} 로 쓰면 치환이 안 된다.
describe("envRequest i18n placeholders", () => {
  test("docs and editing use double-brace placeholders", () => {
    expect(en["envRequest.notice.docs"]).toContain("{{url}}")
    expect(en["envRequest.editing"]).toContain("{{names}}")
    expect(ko["envRequest.notice.docs"]).toContain("{{url}}")
    expect(ko["envRequest.editing"]).toContain("{{names}}")
  })

  test("docs and editing do not leave single-brace placeholders", () => {
    for (const text of [en["envRequest.notice.docs"], ko["envRequest.notice.docs"]]) {
      expect(text).not.toMatch(/(?<!\{)\{url\}(?!\})/)
    }
    for (const text of [en["envRequest.editing"], ko["envRequest.editing"]]) {
      expect(text).not.toMatch(/(?<!\{)\{names\}(?!\})/)
    }
  })
})
