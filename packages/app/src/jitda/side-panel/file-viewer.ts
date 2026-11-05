import type { FileContent } from "@opencode/plugin/gui"
import { FileViewer } from "@opencode/plugin/gui/file"
import { artifactKind, type ArtifactKind } from "@opencode/util/artifact"

export { FileViewer }

// 파일 탭이 코드 뷰와 미디어로 직접 보여 주는 종류다.
const ownKinds = new Set<ArtifactKind>(["text", "image", "svg", "audio", "html", "markdown", "mermaid", "table"])

export function pickFileViewer(viewers: readonly FileViewer[], path: string, content: FileContent | undefined) {
  if (!content || content.type !== "binary" || !content.mimeType) return undefined
  if (!content.bytes && content.encoding !== "base64") return undefined

  const kind = artifactKind(path)
  if (ownKinds.has(kind)) return undefined

  return viewers.find((viewer) => viewer.kinds.includes(kind))
}

// 뷰어가 버퍼를 워커로 옮길 수 있어 복사본을 넘긴다.
export function viewerBytes(content: FileContent) {
  if (content.bytes) return content.bytes.slice()

  const raw = atob(content.content)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}
