import { sentryVitePlugin } from "@sentry/vite-plugin"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import desktopPlugin, { channel } from "./vite.js"
import { icons } from "./vite.icons"
import { serviceWorker } from "./vite.pwa"

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./dist/**",
          filesToDeleteAfterUpload: "./dist/**/*.map",
        },
      })
    : false

// 웹 자산은 CDN(S3)에서 서빙하고 파드는 index.html 만 내려준다. CI 와 Dockerfile 이 이 값을 넘긴다.
const assetBase = process.env.OPENCODE_ASSET_BASE || undefined

export default defineConfig({
  base: assetBase ?? "./",
  plugins: [
    desktopPlugin,
    icons(channel),
    serviceWorker(fileURLToPath(new URL("./dist", import.meta.url)), { precache: !assetBase }),
    sentry,
  ] as any,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
  },
  experimental: {
    // SVG 스프라이트는 <use> 외부 참조라 cross-origin 이 막힌다. CDN 빌드에서 JS 가 참조하는 .svg 만
    // 런타임에 baseURI 기준으로 풀어 파드가 서빙하는 same-origin 경로로 만든다.
    renderBuiltUrl: assetBase
      ? (filename, { hostType }) =>
          hostType === "js" && filename.endsWith(".svg")
            ? { runtime: `globalThis.__sameOriginAsset(${JSON.stringify(filename)})` }
            : undefined
      : undefined,
  },
  build: {
    rolldownOptions: {
      // BlockSuite DI 는 서비스 클래스의 name 을 식별자로 쓴다. 압축이 이름을 지우면 짓다 문서 편집기가 뜨지 않는다.
      output: {
        keepNames: true,
        // 청크마다 맨 앞에 붙어 renderBuiltUrl 런타임 표현식보다 먼저 정의된다.
        ...(assetBase ? { banner: `globalThis.__sameOriginAsset||=function(f){return new URL(f,document.baseURI).href}` } : {}),
      },
      ...(process.env.VITE_OPENCODE_TEST_FIXTURES === "1"
        ? {
            input: [
              "index.html",
              "e2e/utils/settings-wsl.html",
              "e2e/utils/app-direction.html",
              "e2e/utils/windows-menu.html",
            ],
          }
        : {}),
    },
    assetsDir: "_assets",
    target: "esnext",
    sourcemap: true,
  },
})
