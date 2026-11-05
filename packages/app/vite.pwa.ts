import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { PluginOption } from "vite"
import { VitePWA } from "vite-plugin-pwa"

// The Office previews' engines and fonts (about 52 MB) load only when an Office file opens, so they stay out of the
// precache. The app's own fonts have no hyphenated name, such as `assets/Inter.ttf`.
const officeAsset =
  /(?:^|\/)(?:(?:docx_\w+|ooxml_opc|pptx_wasm|xlsx_wasm)_bg-[\w-]+\.wasm|residentEngineWorker-[\w-]+\.js|(?:Carlito|Caladea|LiberationSans|LiberationSerif|LiberationMono|NotoSansArabic|NotoNaskhArabic|NotoSansHebrew|Gelasio|ComicRelief|Inter|Roboto|SourceSans3|DMSans|DMSerifDisplay|OpenSans|Montserrat|Poppins|Oswald|Heebo)-[\w-]+\.ttf)$/

/** Whether a built file loads on demand instead of being precached. */
export function onDemandAsset(path: string) {
  return officeAsset.test(path)
}

// CDN 빌드에서 페이지는 CDN URL 을 요청하므로 same-origin 프리캐시는 쓰이지 않고 파드에서 전체 자산을 받기만 한다.
// 허브 prefix 에서는 index.html 이 <base> 삽입으로 달라져 integrity 도 어긋난다. Workbox 는 빈 프리캐시를 거부하므로
// 등록 경로는 그대로 두고 아무것도 가로채지 않는 sw.js 를 내보낸다.
export function serviceWorker(directory: string, options: { precache: boolean }): PluginOption {
  if (!options.precache)
    return {
      name: "opencode-app:empty-service-worker",
      apply: "build",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "sw.js", source: "// assets are served from the CDN\n" })
      },
    }

  return VitePWA({
    strategies: "generateSW",
    registerType: "prompt",
    injectRegister: false,
    manifest: false,
    workbox: {
      // Workbox runs after Sentry's upload and cleanup, so do not publish an unuploaded map.
      sourcemap: false,
      globDirectory: directory,
      clientsClaim: false,
      // Keep each open tab on its complete build until all old clients close.
      skipWaiting: false,
      inlineWorkboxRuntime: true,
      navigateFallback: "index.html",
      // Pairing links must reach the server so it can set the session cookie.
      navigateFallbackDenylist: [/\/(?:api|auth)(?:\/|$)/, /\/(?:_assets|assets)(?:\/|$)/],
      // Include lazy chunks and non-JS dependencies, not just the startup bundle.
      globPatterns: ["**/*"],
      globIgnores: ["**/*.map", "_headers", "_redirects"],
      maximumFileSizeToCacheInBytes: Number.MAX_SAFE_INTEGER,
      manifestTransforms: [
        async (entries) => ({
          manifest: await Promise.all(
            entries
              .filter((entry) => !onDemandAsset(entry.url))
              .map(async (entry) => ({
              ...entry,
              // A revision labels a cache entry; integrity rejects mixed deployments
              // and HTML fallback responses instead of installing a broken build.
              integrity: `sha256-${createHash("sha256")
                .update(await readFile(resolve(directory, entry.url)))
                .digest("base64")}`,
            })),
          ),
          warnings: [],
        }),
      ],
    },
  })
}
