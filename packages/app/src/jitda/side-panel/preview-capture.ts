import { createSignal } from "solid-js"
import type { PreviewBridge } from "./preview-bridge"

// 막 뜬 미리보기는 penpal 핸드셰이크가 아직 안 끝났을 수 있어 캡처 요청 시 이만큼 연결을 기다린다.
const CAPTURE_CONNECT_WAIT_MS = 2500

const [bridge, setBridge] = createSignal<PreviewBridge | undefined>()
const [capturing, setCapturing] = createSignal(false)
const [canCapture, setCanCapture] = createSignal(false)

// 사이드 패널(미리보기 소유)과 컴포저(캡처→편집→첨부 소유)는 형제라 공통 provider 가 없다. 화면에 세션 패널은
// 하나뿐이므로 V1 SessionPreviewBridge 컨텍스트와 같은 값을 모듈 단위로 둔다.
export const previewCapture = {
  bridge,
  setBridge,
  capturing,
  setCapturing,
  /** 미리보기 URL·ready 이고 패널이 실제 크기를 가질 때만 true. 닫혀 폭이 0 이면 캡처가 빈 이미지가 된다. */
  canCapture,
  setCanCapture,
  /** 미리보기 iframe 안에서 화면을 캡처해 dataURL 반환. 미연결/실패 시 undefined. */
  capture: async (): Promise<string | undefined> => {
    const current = bridge()
    if (!current) return undefined
    let child = current.child()
    if (!child) {
      const deadline = Date.now() + CAPTURE_CONNECT_WAIT_MS
      while (!child && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        child = current.child()
      }
    }
    if (!child) return undefined
    return child.capture().catch(() => undefined)
  },
}
