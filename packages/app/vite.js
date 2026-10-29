import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"

const theme = fileURLToPath(new URL("./public/oc-theme-preload.js", import.meta.url))

const themeScript = readFileSync(theme, "utf8")

const tailwind = tailwindcss()

const pdfjs = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"))

// 짓다 PDF 뷰어(pdf.js)가 런타임에 읽는 cmaps·폰트·wasm·icc 를 V1 처럼 버전 폴더째 빌드 결과에 넣는다.
const pdfjsResources = {
  name: "jitda:pdfjs-resources",
  apply: "build",
  generateBundle() {
    const { version } = JSON.parse(readFileSync(path.join(pdfjs, "package.json"), "utf8"))
    for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"])
      for (const name of readdirSync(path.join(pdfjs, dir)))
        this.emitFile({
          type: "asset",
          fileName: `_assets/pdfjs-${version}/${dir}/${name}`,
          source: readFileSync(path.join(pdfjs, dir, name)),
        })
  },
}

const tailwindGenerate = tailwind.find((plugin) => plugin.name === "@tailwindcss/vite:generate:serve")

const tailwindHotUpdate = tailwindGenerate?.hotUpdate

// Tailwind 4.3.3 expects a server that Vite's bundled dev hook does not provide.
if (tailwindGenerate && typeof tailwindHotUpdate === "function") {
  tailwindGenerate.hotUpdate = function (context) {
    if (!context.server) return

    return tailwindHotUpdate.call(this, context)
  }
}

// The markdown worker imports these directly, so they are served unbundled to keep worker startup
// stable. Vite applies `exclude` to every import inside a pre-bundle too, which would leave a bare
// `import "marked"` in mermaid's chunk that the browser cannot resolve from this package.
const workerDeps = ["@shikijs/stream", "marked", "marked-shiki", "remend"]

// The Office previews load their wasm and fonts through `new URL(..., import.meta.url)`, which a pre-bundle would move
// away from the files.
const officeDeps = ["@betteroffice/docx", "@betteroffice/fonts", "@betteroffice/pptx", "@betteroffice/xlsx"]

// The build emits the Office engines' wasm and worker files for every `new URL(..., import.meta.url)` it sees, even in
// code that tree shaking drops. A file that no other emitted file names never loads, so it is left out of the build.
const officeEmitted = /^(?:docx_\w+_bg|ooxml_opc_bg|pptx_wasm_bg|xlsx_wasm_bg|residentEngineWorker)\b/

/** @type {import("vite").Plugin} */
const dropUnloadedOfficeFiles = {
  name: "opencode-desktop:drop-unloaded-office-files",
  apply: "build",
  generateBundle: {
    order: "post",
    handler(_, bundle) {
      const files = Object.values(bundle).filter((file) => !file.fileName.endsWith(".map"))
      const name = (file) => file.fileName.split("/").pop() ?? file.fileName
      const source = (file) => (file.type === "chunk" ? file.code : typeof file.source === "string" ? file.source : "")
      const named = (file) => files.some((other) => other !== file && source(other).includes(name(file)))

      files
        .filter((file) => officeEmitted.test(name(file)) && !named(file))
        .forEach((file) => {
          delete bundle[file.fileName]
          delete bundle[`${file.fileName}.map`]
        })
    },
  },
}

/** @type {import("rolldown").Plugin} */
const bundleNestedWorkerDeps = {
  name: "opencode-desktop:bundle-nested-worker-deps",
  resolveId(id, importer) {
    if (!importer || !workerDeps.includes(id) || !importer.includes("node_modules")) return

    try {
      return createRequire(importer).resolve(id)
    } catch {
      return
    }
  },
}

export const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL

  if (raw === "local" || raw === "dev" || raw === "beta" || raw === "prod") return raw

  if (process.env.OPENCODE_CHANNEL === "latest") return "prod"

  return "dev"
})()

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
            // The font package imports its 33 MB Chinese, Japanese and Korean add-on on demand; the app does not ship it.
            "@betteroffice/fonts-cjk": fileURLToPath(
              new URL("../gui-extensions/src/microsoft-office/fonts-cjk.ts", import.meta.url),
            ),
          },
        },
        define: {
          "import.meta.env.VITE_OPENCODE_CHANNEL": JSON.stringify(channel),
        },
        worker: {
          format: "es",
        },
        optimizeDeps: {
          exclude: [...workerDeps, ...officeDeps],
          include: [
            "@opencode/session-ui > mermaid",
            "@opencode/session-ui > mermaid > katex",
            "@blocksuite/presets",
            "@blocksuite/blocks",
            "@blocksuite/store",
            "@blocksuite/block-std",
          ],
          rolldownOptions: { plugins: [bundleNestedWorkerDeps] },
        },
      }
    },
  },
  dropUnloadedOfficeFiles,
  pdfjsResources,
  {
    name: "opencode-desktop:theme-preload",
    transformIndexHtml: {
      order: "pre",
      handler: inlineThemePreload,
    },
  },
  ...tailwind,
  solidPlugin(),
]

export function inlineThemePreload(html) {
  return html.replace(
    /<script id="oc-theme-preload-script" src="(?:\.\/|\/)oc-theme-preload\.js"><\/script>/,
    `<script id="oc-theme-preload-script">${themeScript}</script>`,
  )
}
