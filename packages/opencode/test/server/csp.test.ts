import { describe, expect, test } from "bun:test"
import { DEFAULT_CSP } from "../../src/server/csp"

describe("csp", () => {
  test("allows doc image object urls", () => {
    expect(DEFAULT_CSP).toContain("img-src 'self' data: blob: https:")
  })

  test("allows same-origin blob workers for the CDN cross-origin worker shim", () => {
    expect(DEFAULT_CSP).toContain("worker-src 'self' blob:")
  })
})
