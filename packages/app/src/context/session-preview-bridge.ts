import { createSimpleContext } from "@opencode-ai/ui/context"
import { createSignal } from "solid-js"
import type { PreviewBridge } from "@/pages/session/preview-bridge"

// 미리보기 패널(SessionSidePanel)이 만든 PreviewBridge 를 컴포저(PromptInput) 등 다른 곳에서
// 쓸 수 있게 공유한다. PromptDocBridge 와 동일한 register-callback 패턴.
export const { use: useSessionPreviewBridge, provider: SessionPreviewBridgeProvider } = createSimpleContext({
  name: "SessionPreviewBridge",
  gate: false,
  init: () => {
    const [bridge, setBridge] = createSignal<PreviewBridge | undefined>()
    // 캡처 진행 상태는 컴포저(PromptInput, 캡처→편집→첨부 플로우 소유)가 관리하며
    // doc 첨부 메뉴의 "미리보기 캡처" 항목이 진행 중 여부를 표시하는 데 쓴다.
    const [capturing, setCapturing] = createSignal(false)

    return {
      bridge,
      setBridge,
      capturing,
      setCapturing,
      /** 미리보기 iframe 안에서 화면을 캡처해 dataURL 반환. 미연결/실패 시 undefined. */
      capture: async (): Promise<string | undefined> => {
        const child = bridge()?.child()
        if (!child) return undefined
        try {
          return await child.capture()
        } catch {
          return undefined
        }
      },
    }
  },
})
