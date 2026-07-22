import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { DEFAULT_CSP, csp, themePreloadHash } from "../../src/server/csp"

describe("csp", () => {
  test("allows doc image object urls", () => {
    expect(DEFAULT_CSP).toContain("img-src 'self' data: blob: https:")
  })

  test("allows same-origin blob workers for the CDN cross-origin worker shim", () => {
    expect(DEFAULT_CSP).toContain("worker-src 'self' blob:")
  })
})

describe("themePreloadHash", () => {
  const inline = (body: string) => `<head><script id="oc-theme-preload-script">${body}</script></head>`

  test("hashes the inlined preload script so script-src can allow it", () => {
    const body = `;(function () { document.documentElement.dataset.theme = "jitda" })()`
    const hash = themePreloadHash(inline(body))
    expect(hash).toBe(createHash("sha256").update(body).digest("base64"))
    expect(csp(hash)).toContain(`'sha256-${hash}'`)
  })

  // src 가 붙어 있으면 외부 스크립트라 해시 대상이 아니다. 빌드가 인라인화에 실패했는데
  // 해시를 넣어버리면 CSP 만 헐거워지고 원인은 감춰진다.
  test("returns no hash when the script was left external", () => {
    expect(themePreloadHash(`<head><script id="oc-theme-preload-script" src="/oc-theme-preload.js"></script></head>`))
      .toBe("")
    expect(csp("")).not.toContain("sha256-")
  })

  test("returns no hash when the script is absent", () => {
    expect(themePreloadHash("<head></head>")).toBe("")
  })
})
