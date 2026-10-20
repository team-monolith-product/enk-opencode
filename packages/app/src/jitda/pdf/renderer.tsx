import { lazy, Suspense, type Component } from "solid-js"
import { bindExtension, Registry, type Setup } from "@opencode/gui-extensions/sdk"
import type { ArtifactKind } from "@opencode/util/artifact"
import { useLanguage } from "@/runtime/i18n/language"
import type definition from "./extension"

// gui-extensions 는 file 계약(FileViewer)을 패키지 밖으로 내보내지 않는다. 호스트는 레지스트리를 id 로 찾으므로
// 같은 id·모양으로 선언한다. path 는 호스트가 넘겨줄 때만 쓴다(V1 처럼 상태 화면에 파일 이름을 보인다).
export type FileViewerProps = {
  readonly bytes: Uint8Array
  readonly path?: string
  onDetails(details: readonly string[]): void
  onError(reason?: string): void
}

export const FileViewer = Registry.define<{
  readonly kinds: readonly ArtifactKind[]
  problem?(bytes: Uint8Array): string | undefined
  readonly View: Component<FileViewerProps>
}>("file.viewer")

const PdfViewer = lazy(() => import("./pdf-viewer"))

export function PdfFileView(props: FileViewerProps) {
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

const setup: Setup<typeof definition> = (ctx) => {
  ctx.add(FileViewer, { kinds: ["pdf"], View: bindExtension(PdfFileView) })
}

export default setup
