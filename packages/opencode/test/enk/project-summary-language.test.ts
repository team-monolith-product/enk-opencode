import { describe, expect, test } from "bun:test"
import { ProjectSummaryLanguage } from "../../src/enk/project-summary-language"

const user = (locale?: "ko" | "en") => ({ info: { role: "user", locale } })
const assistant = () => ({ info: { role: "assistant" } })

describe("ProjectSummaryLanguage.resolve", () => {
  test("요청에 locale 이 있으면 그것을 쓴다", () => {
    expect(ProjectSummaryLanguage.resolve({ requested: "en", messages: [user("ko")] })).toBe("en")
  })

  test("요청에 없으면 마지막 user 메시지의 locale 을 쓴다", () => {
    expect(
      ProjectSummaryLanguage.resolve({ messages: [user("ko"), assistant(), user("en"), assistant()] }),
    ).toBe("en")
  })

  test("locale 이 없는 최근 user 메시지는 건너뛴다", () => {
    expect(ProjectSummaryLanguage.resolve({ messages: [user("en"), user(undefined), assistant()] })).toBe("en")
  })

  test("아무 단서도 없으면 기본값 ko", () => {
    expect(ProjectSummaryLanguage.resolve({ messages: [] })).toBe("ko")
    expect(ProjectSummaryLanguage.resolve({ messages: [user(undefined)] })).toBe("ko")
  })
})

describe("ProjectSummaryLanguage.directive", () => {
  test("en 은 영어로 쓰라고 명시한다", () => {
    expect(ProjectSummaryLanguage.directive("en")).toContain("in English")
  })

  test("ko 는 한국어로 쓰라고 명시한다", () => {
    expect(ProjectSummaryLanguage.directive("ko")).toContain("한국어로")
  })
})
