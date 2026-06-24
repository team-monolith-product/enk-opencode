import { defineConfig } from "vite"
import desktopPlugin from "./vite"

export default defineConfig({
  base: process.env.OPENCODE_ASSET_BASE,
  plugins: [desktopPlugin] as any,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3001,
  },
  build: {
    target: "esnext",
    // sourcemap: true,
  },
})
