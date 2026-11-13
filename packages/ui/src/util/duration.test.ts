import { describe, expect, test } from "bun:test"
import type { UiI18n } from "../context/i18n"
import { dict } from "../i18n/en"
import { formatDuration } from "./duration"

const i18n: UiI18n = {
  locale: () => "en",
  t: (key, params) => dict[key].replace(/{{(\w+)}}/g, (_, name) => String(params?.[name] ?? "")),
}
const numfmt = new Intl.NumberFormat("en")
const format = (ms: number) => formatDuration(i18n, numfmt, ms)

describe("formatDuration", () => {
  test("진행 중 표시와 완료 표시가 같은 반올림 규칙을 쓴다", () => {
    expect(format(0)).toBe("0s")
    expect(format(8_600)).toBe("9s")
    expect(format(59_400)).toBe("59s")
    expect(format(59_600)).toBe("1m 0s")
    expect(format(125_000)).toBe("2m 5s")
  })
})
