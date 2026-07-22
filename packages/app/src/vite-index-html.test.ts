import { describe, expect, test } from "bun:test"
import plugins from "../vite.js"

// OPENCODE_ASSET_BASE 가 CDN 이면 Vite 가 index.html 의 /-시작 자산 URL 을 CDN 절대 URL 로
// 재작성한 뒤에야 post 단계 훅이 돈다. 두 훅 모두 그 재작성된 형태를 입력으로 받으므로
// 픽스처도 재작성 후 모양으로 둔다. 재작성 전 리터럴에 의존하면 CDN 빌드에서만 조용히
// 불발되는데, 실제로 theme-preload 가 그렇게 깨져 있었다.
const CDN = "https://cdn.test"
const html = (head: string) => `<!doctype html>\n<html>\n  <head>\n${head}\n  </head>\n  <body></body>\n</html>`

const handler = (name: string) => {
  const plugin = (plugins as any[]).find((it) => it?.name === name)
  if (!plugin) throw new Error(`plugin not found: ${name}`)
  const hook = plugin.transformIndexHtml
  expect(hook.order).toBe("post")
  return hook.handler as (html: string) => string
}

describe("opencode-desktop:same-origin-manifest", () => {
  const transform = handler("opencode-desktop:same-origin-manifest")

  test("rewrites the CDN manifest url back to same-origin", () => {
    const out = transform(html(`    <link rel="manifest" href="${CDN}/site.webmanifest" />`))
    expect(out).toContain('<link rel="manifest" href="/site.webmanifest" />')
    expect(out).not.toContain(CDN)
  })

  test("leaves other CDN assets alone", () => {
    const out = transform(
      html(
        [
          `    <link rel="icon" href="${CDN}/favicon-v3.svg" />`,
          `    <link rel="manifest" href="${CDN}/site.webmanifest" />`,
          `    <link rel="stylesheet" href="${CDN}/assets/index.css" />`,
        ].join("\n"),
      ),
    )
    expect(out).toContain(`<link rel="icon" href="${CDN}/favicon-v3.svg" />`)
    expect(out).toContain(`<link rel="stylesheet" href="${CDN}/assets/index.css" />`)
    expect(out).toContain('href="/site.webmanifest"')
  })
})

describe("opencode-desktop:theme-preload", () => {
  const transform = handler("opencode-desktop:theme-preload")

  test("inlines the preload script even after the src was rewritten to the CDN", () => {
    const out = transform(
      html(`    <script id="oc-theme-preload-script" src="${CDN}/oc-theme-preload.js"></script>`),
    )
    expect(out).not.toContain("oc-theme-preload.js")
    // 인라인 스크립트만 CSP sha256 해시 대상이 된다(server/instance.ts themePreloadHash).
    expect(out).toMatch(/<script id="oc-theme-preload-script">[\s\S]*opencode-theme-id[\s\S]*<\/script>/)
  })

  test("inlines the same script when base is relative", () => {
    const out = transform(html(`    <script id="oc-theme-preload-script" src="/oc-theme-preload.js"></script>`))
    expect(out).not.toContain("src=")
    expect(out).toContain("opencode-color-scheme")
  })
})
