import { createSimpleContext } from "@opencode-ai/ui/context"
import { createSignal } from "solid-js"
import type { PreviewBridge } from "@/pages/session/preview-bridge"

// 미리보기가 막 떴을 때는 penpal 핸드셰이크(iframe load 후 완료)가 아직 안 끝나 child() 가 비어 있을 수 있다.
// 캡처 요청 시 곧바로 실패시키지 말고 이만큼 연결을 기다린다(정상 케이스는 수백 ms 안에 붙는다).
const CAPTURE_CONNECT_WAIT_MS = 2500

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
    // 캡처 가능 여부 — 미리보기 URL·ready·리뷰 패널 열림을 아는 SessionSidePanel 이 push 한다.
    // (미리보기 탭을 안 보고 있어도 패널만 열려 있으면 상시 마운트된 iframe 을 캡처할 수 있어 true.
    //  패널이 닫혀 레이어 크기가 0 이면 캡처가 빈 이미지라 false → 캡처 버튼을 비활성화한다.)
    const [canCapture, setCanCapture] = createSignal(false)

    return {
      bridge,
      setBridge,
      capturing,
      setCapturing,
      canCapture,
      setCanCapture,
      /** 미리보기 iframe 안에서 화면을 캡처해 dataURL 반환. 미연결/실패 시 undefined. */
      capture: async (): Promise<string | undefined> => {
        const b = bridge()
        if (!b) return undefined
        // 첫 미리보기 직후 등 아직 핸드셰이크가 안 끝났으면 잠깐 연결을 기다린다(즉시 실패 방지).
        let child = b.child()
        if (!child) {
          const deadline = Date.now() + CAPTURE_CONNECT_WAIT_MS
          while (!child && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100))
            child = b.child()
          }
        }
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
