import { describe, expect, test } from "bun:test"
import { MediaTokens } from "../../src/session/media-tokens"

/** 페이지 오브젝트가 그대로 보이는 평범한 PDF. padding 으로 바이트만 부풀릴 수 있다. */
function pdf(pages: number, padding = 0) {
  const objects = Array.from(
    { length: pages },
    (_, i) => `${i + 3} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n`,
  ).join("")
  return Buffer.from(
    `%PDF-1.4\n` +
      `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` +
      `2 0 obj\n<< /Type /Pages /Count ${pages} >>\nendobj\n` +
      objects +
      (padding ? `% ${"x".repeat(padding)}\n` : "") +
      `trailer\n<< /Root 1 0 R >>\n%%EOF\n`,
    "latin1",
  )
}

const dataURL = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString("base64")}`

describe("MediaTokens.pdfPageCount", () => {
  test("페이지 오브젝트를 센다 (/Type /Pages 트리 노드는 제외)", () => {
    expect(MediaTokens.pdfPageCount(pdf(1))).toBe(1)
    expect(MediaTokens.pdfPageCount(pdf(5))).toBe(5)
    expect(MediaTokens.pdfPageCount(pdf(20))).toBe(20)
  })

  test("페이지 오브젝트가 안 보이면 페이지 트리의 /Count 로 떨어진다", () => {
    // 오브젝트 스트림에 압축된 PDF 를 흉내낸다: /Count 만 평문에 남는다.
    const compressed = Buffer.from(`%PDF-1.5\n2 0 obj\n<< /Count 7 >>\nendobj\ntrailer\n%%EOF\n`, "latin1")
    expect(MediaTokens.pdfPageCount(compressed)).toBe(7)
  })

  test("둘 다 못 찾으면 undefined", () => {
    expect(MediaTokens.pdfPageCount(Buffer.from("%PDF-1.7\ngarbage\n%%EOF\n", "latin1"))).toBeUndefined()
  })
})

describe("MediaTokens.estimate", () => {
  // 이 테스트가 회계의 핵심 전제다. 통제 실험에서 1페이지 PDF 는 0.34MB 든 1.80MB 든
  // 토큰이 동일했고(minimax 2,721 / anthropic 1,579), 20페이지는 0.34MB 든 8.86MB 든 동일했다.
  test("바이트가 아니라 페이지 수에 비례한다", () => {
    const small = MediaTokens.estimate({ mime: "application/pdf", url: dataURL("application/pdf", pdf(3)) })
    const padded = MediaTokens.estimate({
      mime: "application/pdf",
      url: dataURL("application/pdf", pdf(3, 2_000_000)),
    })
    expect(padded).toBe(small)
    expect(small).toBe(3 * MediaTokens.PDF_PER_PAGE)

    const twenty = MediaTokens.estimate({ mime: "application/pdf", url: dataURL("application/pdf", pdf(20)) })
    expect(twenty).toBe(20 * MediaTokens.PDF_PER_PAGE)
  })

  test("페이지 수를 못 읽는 PDF 는 0 이 아니라 보수적인 기본값으로 센다", () => {
    const opaque = Buffer.from("%PDF-1.7\ngarbage\n%%EOF\n", "latin1")
    expect(MediaTokens.estimate({ mime: "application/pdf", url: dataURL("application/pdf", opaque) })).toBe(
      MediaTokens.UNKNOWN_PDF_PAGES * MediaTokens.PDF_PER_PAGE,
    )
  })

  test("이미지는 고정값, 미디어가 아닌 첨부는 0", () => {
    expect(MediaTokens.estimate({ mime: "image/png", url: "data:image/png;base64,xxx" })).toBe(MediaTokens.IMAGE)
    expect(MediaTokens.estimate({ mime: "image/jpeg", url: "data:image/jpeg;base64,xxx" })).toBe(MediaTokens.IMAGE)
    expect(MediaTokens.estimate({ mime: "text/plain", url: "data:text/plain;base64,xxx" })).toBe(0)
  })

  test("data URL 이 아닌 PDF 도 0 으로 새지 않는다", () => {
    expect(MediaTokens.estimate({ mime: "application/pdf", url: "file:///tmp/a.pdf" })).toBe(
      MediaTokens.UNKNOWN_PDF_PAGES * MediaTokens.PDF_PER_PAGE,
    )
  })

  test("estimateAll: 합산하고, 첨부가 없으면 0", () => {
    expect(MediaTokens.estimateAll()).toBe(0)
    expect(MediaTokens.estimateAll([])).toBe(0)
    expect(
      MediaTokens.estimateAll([
        { mime: "image/png", url: "data:image/png;base64,xxx" },
        { mime: "application/pdf", url: dataURL("application/pdf", pdf(2)) },
      ]),
    ).toBe(MediaTokens.IMAGE + 2 * MediaTokens.PDF_PER_PAGE)
  })
})
