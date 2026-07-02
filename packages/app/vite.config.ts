import { defineConfig } from "vite"
import desktopPlugin from "./vite"

export default defineConfig({
  base: process.env.OPENCODE_ASSET_BASE || "./",
  plugins: [desktopPlugin] as any,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3001,
  },
  experimental: {
    // SVG 스프라이트는 <use> 외부 참조라 cross-origin 이 차단된다. OPENCODE_ASSET_BASE 가 CDN 일 때
    // 다른 자산은 CORS 로 로드되지만 .svg 만 same-origin 이어야 하므로, 전역 base 접두 대신 런타임에
    // baseURI 기준으로 해석해 pod 가 서빙하는 same-origin 경로로 만든다. filename 은 base 미접두 상대경로다.
    renderBuiltUrl(filename, { hostType }) {
      if (hostType === "js" && filename.endsWith(".svg")) {
        return { runtime: `globalThis.__sameOriginAsset(${JSON.stringify(filename)})` }
      }
      return undefined
    },
  },
  build: {
    target: "esnext",
    // sourcemap: true,
    rollupOptions: {
      output: {
        // 각 청크 최상단에 prepend 되어 renderBuiltUrl 런타임 표현식보다 먼저 정의된다.
        banner: `globalThis.__sameOriginAsset||=function(f){return new URL(f,document.baseURI).href}`,
      },
    },
  },
})
