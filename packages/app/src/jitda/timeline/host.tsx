import { createSignal } from "solid-js"
import type { MessageDocView, MessageHost } from "@opencode/session-ui/message"
import { useJitda } from "@/jitda/context"
import { Flags } from "@/jitda/flags"
import { JitdaContextToolGroup } from "./context-tool-group"
import { JitdaSessionError, JitdaToolError } from "./tool-error"
import { jitdaTool } from "./tools"
import "./timeline.css"

// 문서 메시지의 읽기 전용 뷰어(V1 data.doc). 뷰어를 가진 쪽이 등록하고, 없으면 메시지 본문(마크다운)을 보인다.
const [docView, setDocView] = createSignal<MessageDocView>()

export function registerJitdaDocView(component: MessageDocView | undefined) {
  setDocView(() => component)
}

// 업로드는 서버 기준 상대 주소(앞에 허브 경로가 붙을 수 있는 /api/jitda/doc/{docID}/asset/{id})로 저장된다.
// 주소는 지금 연결한 서버 기준으로 다시 만들고, img 는 헤더를 못 실으므로 인증 쿼리를 붙인다.
export function jitdaAssetUrl(
  socket: (path: string, query: Record<string, string | undefined>) => string,
  url: string,
) {
  const index = url.indexOf("/api/jitda/")
  if (!url.startsWith("/") || index < 0) return url
  const parsed = new URL(url.slice(index), "http://jitda.internal")
  const next = new URL(socket(parsed.pathname, Object.fromEntries(parsed.searchParams)))
  next.protocol = next.protocol === "wss:" ? "https:" : "http:"
  return next.toString()
}

export function createJitdaMessageHost(): MessageHost {
  const jitda = useJitda()

  return {
    hideUserMeta: true,
    fileChips: true,
    paperEdge: true,
    partialInput: true,
    assetUrl: (url) => jitdaAssetUrl(jitda.socket, url),
    get doc() {
      return docView()
    },
    tool: jitdaTool,
    toolError: JitdaToolError,
    sessionError: JitdaSessionError,
    contextGroup: JitdaContextToolGroup,
  }
}

export const jitdaTimelineEnabled = Flags.productionLayout
