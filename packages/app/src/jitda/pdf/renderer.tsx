import { lazy, Suspense } from "solid-js"
import { bindPlugin, type Plugin } from "@opencode/plugin/gui"
import { FileViewer, type FileViewerProps } from "@opencode/plugin/gui/file"
import { useLanguage } from "@/runtime/i18n/language"
import type definition from "./extension"

// path 는 호스트가 넘겨줄 때만 쓴다(V1 처럼 상태 화면에 파일 이름을 보인다).
export type JitdaFileViewerProps = FileViewerProps & { readonly path?: string }

const PdfViewer = lazy(() => import("./pdf-viewer"))

export function PdfFileView(props: JitdaFileViewerProps) {
  const language = useLanguage()
  return (
    <div class="relative flex min-h-0 flex-1 flex-col">
      <Suspense
        fallback={
          <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
            {language.t("ui.fileMedia.state.loading", { kind: language.t("ui.fileMedia.kind.pdf") })}
          </div>
        }
      >
        <PdfViewer data={props.bytes} name={props.path?.split("/").pop()} />
      </Suspense>
    </div>
  )
}

const setup: Plugin.Setup<typeof definition> = (ctx) => {
  ctx.add(FileViewer, { kinds: ["pdf"], View: bindPlugin(PdfFileView) })
}

export default setup
