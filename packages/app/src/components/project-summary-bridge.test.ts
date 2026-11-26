import { describe, expect, test } from "bun:test"
import { summaryLocale } from "./project-summary-bridge"

describe("summaryLocale", () => {
  test("호스트가 넘긴 locale 이 iframe 언어보다 우선한다", () => {
    expect(summaryLocale("en", "ko")).toBe("en")
    expect(summaryLocale("ko", "en")).toBe("ko")
  })

  test("호스트 locale 이 없으면 iframe 언어를 쓴다", () => {
    expect(summaryLocale(undefined, "en")).toBe("en")
    expect(summaryLocale(undefined, "ko")).toBe("ko")
    expect(summaryLocale(undefined, "ar")).toBe("ar")
  })

  test("지원하지 않는 iframe 언어는 보내지 않는다", () => {
    expect(summaryLocale(undefined, "ja")).toBeUndefined()
  })
})
