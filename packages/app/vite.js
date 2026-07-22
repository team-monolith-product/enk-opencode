import { readFileSync } from "node:fs"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"

const theme = fileURLToPath(new URL("./public/oc-theme-preload.js", import.meta.url))

/**
 * @type {import("vite").PluginOption}
 */
export default [
  {
    name: "opencode-desktop:config",
    config() {
      return {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
          },
        },
        optimizeDeps: {
          include: [
            "@blocksuite/presets",
            "@blocksuite/blocks",
            "@blocksuite/store",
            "@blocksuite/block-std",
          ],
        },
        worker: {
          format: "es",
        },
      }
    },
  },
  {
    name: "opencode-desktop:theme-preload",
    transformIndexHtml: {
      // OPENCODE_ASSET_BASE 가 CDN 이면 Vite 가 src 를 CDN 절대 URL 로 재작성한다. 재작성 전 리터럴
      // 경로로 매칭하면 CDN 빌드에서만 인라인화가 조용히 불발되므로, post 단계에서 id 로 매칭한다.
      order: "post",
      handler(html) {
        return html.replace(
          /<script\b[^>]*\bid="oc-theme-preload-script"[^>]*><\/script>/,
          () => `<script id="oc-theme-preload-script">${readFileSync(theme, "utf8")}</script>`,
        )
      },
    },
  },
  {
    // OPENCODE_ASSET_BASE 가 CDN 이면 Vite 가 index.html 의 /site.webmanifest 까지 CDN 절대 URL 로
    // 재작성한다. manifest 는 CSP 에서 manifest-src 미지정 시 default-src 'self' 로 폴백되어 막히고,
    // 풀어주더라도 cross-origin manifest 는 crossorigin 속성 + CDN CORS 가 추가로 필요하다.
    // CDN 에 둘 이유가 없는 자산이므로 pod 가 서빙하는 same-origin 경로로 되돌린다.
    name: "opencode-desktop:same-origin-manifest",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        return html.replace(
          /(<link\b[^>]*\brel="manifest"[^>]*\bhref=")[^"]*(")/g,
          "$1/site.webmanifest$2",
        )
      },
    },
  },
  tailwindcss(),
  solidPlugin(),
]
