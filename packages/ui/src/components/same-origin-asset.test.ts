import { afterEach, describe, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { sameOriginAssetUrl } from "./same-origin-asset"

const prevDocument = (globalThis as { document?: unknown }).document
const prevLocation = (globalThis as { location?: unknown }).location

function mountDom(pageUrl: string, baseHref: string) {
  const dom = new JSDOM(`<!doctype html><html><head><base href="${baseHref}"></head><body></body></html>`, {
    url: pageUrl,
  })
  ;(globalThis as { document: unknown }).document = dom.window.document
  ;(globalThis as { location: unknown }).location = dom.window.location
}

afterEach(() => {
  ;(globalThis as { document: unknown }).document = prevDocument
  ;(globalThis as { location: unknown }).location = prevLocation
})

describe("sameOriginAssetUrl", () => {
  test("rewrites a cross-origin CDN asset onto the page origin under basePath", () => {
    mountDom("https://opencode.jitda.io/user/abc/", "/user/abc/")
    expect(sameOriginAssetUrl("https://dbl58za30prx0.cloudfront.net/assets/sprite-Fb.svg")).toBe(
      "https://opencode.jitda.io/user/abc/assets/sprite-Fb.svg",
    )
  })

  test("leaves a same-origin asset unchanged", () => {
    mountDom("https://opencode.jitda.io/user/abc/", "/user/abc/")
    const url = "https://opencode.jitda.io/user/abc/assets/sprite-Fb.svg"
    expect(sameOriginAssetUrl(url)).toBe(url)
  })

  test("resolves a root-relative asset against the page origin", () => {
    mountDom("https://opencode.dev.jitda.io/", "/")
    expect(sameOriginAssetUrl("/assets/sprite-Fb.svg")).toBe("https://opencode.dev.jitda.io/assets/sprite-Fb.svg")
  })
})
