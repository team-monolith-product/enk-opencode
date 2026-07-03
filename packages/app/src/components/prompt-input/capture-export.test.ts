import { describe, expect, it } from "bun:test"
import { fitImageToByteLimit } from "./capture-export"

const LIMIT = 10 * 1024 * 1024

function file(bytes: number, type: string, name: string): File {
  // 실제 바이트로 크기를 만든다(File.size 가 정확해야 분기 검증이 유효).
  return new File([new Uint8Array(bytes)], name, { type })
}

describe("fitImageToByteLimit", () => {
  it("상한 이하 파일은 손대지 않고 원본을 그대로 반환한다", async () => {
    const small = file(1024, "image/png", "shot.png")
    const out = await fitImageToByteLimit(small, LIMIT)
    expect(out).toBe(small)
  })

  it("이미지가 아닌 초과 파일은 줄일 수 없어 원본을 그대로 반환한다(호출부가 거절)", async () => {
    const pdf = file(LIMIT + 1, "application/pdf", "big.pdf")
    const out = await fitImageToByteLimit(pdf, LIMIT)
    expect(out).toBe(pdf)
    expect(out.size).toBeGreaterThan(LIMIT)
  })

  // NOTE: 실제 이미지 재인코딩/축소 경로는 canvas.toBlob + Image load 이벤트가 필요해
  // happy-dom(단위 테스트) 에서는 검증할 수 없다. 그 경로는 브라우저 프리뷰로 확인한다.
})
