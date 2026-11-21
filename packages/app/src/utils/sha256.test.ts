import { describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import { sha256, sha256Sync } from "./sha256"

const expected = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

describe("sha256", () => {
  // 패딩이 블록 하나·둘로 갈리는 경계(55/56/63/64 바이트)와 여러 블록을 고루 덮는다.
  test.each([0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 1000, 100_003])("pure JS matches node for %i bytes", (size) => {
    const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7) & 0xff)
    expect(sha256Sync(bytes)).toBe(expected(bytes))
  })

  test("uses the same value with and without crypto.subtle", async () => {
    const bytes = Uint8Array.from({ length: 4097 }, (_, i) => i & 0xff)
    const blob = new Blob([bytes])
    expect(await sha256(blob)).toBe(expected(bytes))
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto")
    Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true })
    try {
      expect(await sha256(blob)).toBe(expected(bytes))
    } finally {
      Object.defineProperty(globalThis, "crypto", original!)
    }
  })
})
