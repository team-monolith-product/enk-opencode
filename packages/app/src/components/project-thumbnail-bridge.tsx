import { PostMessageManagerImpl } from "@team-monolith/post-message-manager"
import { onCleanup, onMount } from "solid-js"
import { useSessionPreviewBridge } from "@/context/session-preview-bridge"

type Result = { status: "ok"; dataUrl: string } | { status: "unavailable" } | { status: "failed"; error: string }

const TIMEOUT_MS = 15_000

/**
 * 부모(해커톤 앱)가 갤러리 썸네일용으로 요청하는 미리보기 화면 캡처 브릿지.
 * 컴포저의 "미리보기 캡처"와 같은 경로(PreviewBridge.capture)를 쓴다.
 *
 * 미리보기 레이어가 실제로 보이지 않으면(canCapture false) 빈 이미지가 나오므로 unavailable 로 답하고,
 * 부모는 자동 채우기를 조용히 건너뛴다. ProjectSummaryBridge 와 달리 세션 컨텍스트가 필요해
 * SessionProviders 안에서 마운트한다.
 */
export function ProjectThumbnailBridge() {
  const previewBridge = useSessionPreviewBridge()

  onMount(() => {
    const pmm = new PostMessageManagerImpl(TIMEOUT_MS)
    pmm.register({
      messageType: "project.thumbnail.request",
      callback: async (): Promise<Result> => {
        if (!previewBridge.canCapture()) return { status: "unavailable" }
        const dataUrl = await previewBridge.capture()
        return dataUrl ? { status: "ok", dataUrl } : { status: "failed", error: "capture failed" }
      },
    })
    onCleanup(() => pmm.unregister("project.thumbnail.request"))
  })

  return null
}
